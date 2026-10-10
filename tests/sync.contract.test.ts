import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { createApp } from "../src/app";
import { MemoryStore } from "../src/adapters/memoryStore";
import { FakeProvider } from "../src/adapters/fakeProvider";
import type { PostSnapshot } from "../src/domain/types";

const POSTS: PostSnapshot[] = [
  {
    provider: "instagram",
    postId: "post-1",
    publishedAt: "2026-09-10T10:00:00.000Z",
    likes: 120,
    comments: 8,
    shares: 3,
    views: 1500,
  },
];

const servers: import("node:http").Server[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }
});

async function startApp(app: Express): Promise<string> {
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function buildApp(provider = new FakeProvider(POSTS)) {
  return createApp({
    provider,
    store: new MemoryStore(["creator-1"]),
    clock: { now: () => new Date("2026-10-01T12:00:00.000Z") },
    sleeper: { sleep: async () => {} },
  });
}

const VALID_BODY = JSON.stringify({
  creatorId: "creator-1",
  provider: "instagram",
  windowFrom: "2026-09-01T00:00:00.000Z",
  windowTo: "2026-10-01T00:00:00.000Z",
});

function postSync(baseUrl: string, body: string, auth = true) {
  return fetch(`${baseUrl}/sync`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: "Bearer fake-token" } : {}),
    },
    body,
  });
}

describe("api contract", () => {
  it("leaves health open without auth", async () => {
    const baseUrl = await startApp(buildApp());
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("rejects sync and listing without a bearer token", async () => {
    const baseUrl = await startApp(buildApp());

    const syncResponse = await postSync(baseUrl, VALID_BODY, false);
    expect(syncResponse.status).toBe(401);
    expect(await syncResponse.json()).toEqual({ error: "UNAUTHORIZED" });

    const listResponse = await fetch(`${baseUrl}/creators/creator-1/posts`);
    expect(listResponse.status).toBe(401);
  });

  it("accepts any bearer token value", async () => {
    const baseUrl = await startApp(buildApp());
    const response = await postSync(baseUrl, VALID_BODY);
    expect(response.status).toBe(200);
  });

  it("rejects inverted and unparsable windows without calling the provider", async () => {
    const provider = new FakeProvider(POSTS);
    const baseUrl = await startApp(buildApp(provider));

    for (const [windowFrom, windowTo] of [
      ["2026-10-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z"],
      ["2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z"],
      ["not-a-date", "2026-10-01T00:00:00.000Z"],
    ]) {
      const response = await postSync(
        baseUrl,
        JSON.stringify({
          creatorId: "creator-1",
          provider: "instagram",
          windowFrom,
          windowTo,
        }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "INVALID_WINDOW" });
    }
    expect(provider.calls).toBe(0);
  });

  it("rejects unknown providers", async () => {
    const baseUrl = await startApp(buildApp());
    const response = await postSync(
      baseUrl,
      JSON.stringify({
        creatorId: "creator-1",
        provider: "myspace",
        windowFrom: "2026-09-01T00:00:00.000Z",
        windowTo: "2026-10-01T00:00:00.000Z",
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "UNKNOWN_PROVIDER" });
  });

  it("returns 404 for unknown creators", async () => {
    const baseUrl = await startApp(buildApp());

    const syncResponse = await postSync(
      baseUrl,
      JSON.stringify({
        creatorId: "ghost",
        provider: "instagram",
        windowFrom: "2026-09-01T00:00:00.000Z",
        windowTo: "2026-10-01T00:00:00.000Z",
      }),
    );
    expect(syncResponse.status).toBe(404);
    expect(await syncResponse.json()).toEqual({ error: "CREATOR_NOT_FOUND" });

    const listResponse = await fetch(`${baseUrl}/creators/ghost/posts`, {
      headers: { authorization: "Bearer fake-token" },
    });
    expect(listResponse.status).toBe(404);
  });

  it("maps exhausted retries to 502 without undoing upserts", async () => {
    const baseUrl = await startApp(
      buildApp(
        new FakeProvider(POSTS, {
          failures: ["rate-limited", "rate-limited"],
          retryAfterSeconds: 7,
        }),
      ),
    );

    const response = await fetch(`${baseUrl}/sync`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer fake-token",
      },
      body: JSON.stringify({
        creatorId: "creator-1",
        provider: "instagram",
        windowFrom: "2026-09-01T00:00:00.000Z",
        windowTo: "2026-10-01T00:00:00.000Z",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      synced: 1,
      deduplicated: 0,
      retries: 2,
    });
  });

  it("returns 502 when every attempt is rate limited", async () => {
    const baseUrl = await startApp(
      buildApp(
        new FakeProvider(POSTS, {
          failures: [
            "rate-limited",
            "rate-limited",
            "rate-limited",
            "rate-limited",
            "rate-limited",
          ],
          retryAfterSeconds: 9,
        }),
      ),
    );

    const response = await postSync(baseUrl, VALID_BODY);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "SYNC_EXHAUSTED",
      retries: 4,
      retryAfterSeconds: 9,
    });
  });

  it("returns json 404 for unknown routes", async () => {
    const baseUrl = await startApp(buildApp());
    const response = await fetch(`${baseUrl}/nope`, {
      headers: { authorization: "Bearer fake-token" },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "NOT_FOUND" });
  });
});
