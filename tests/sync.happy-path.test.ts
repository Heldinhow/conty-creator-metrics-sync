import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { createApp } from "../src/app";
import { MemoryStore } from "../src/adapters/memoryStore";
import { FakeProvider } from "../src/adapters/fakeProvider";
import type { PostSnapshot } from "../src/domain/types";

const FIXED_NOW = "2026-10-01T12:00:00.000Z";

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
  {
    provider: "instagram",
    postId: "post-2",
    publishedAt: "2026-09-12T10:00:00.000Z",
    likes: 340,
    comments: 21,
    shares: 11,
    views: 4200,
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

function buildApp() {
  return createApp({
    provider: new FakeProvider(POSTS),
    store: new MemoryStore(["creator-1"]),
    clock: { now: () => new Date(FIXED_NOW) },
    sleeper: { sleep: async () => {} },
  });
}

describe("sync happy path", () => {
  it("syncs posts in the window and reports counts", async () => {
    const baseUrl = await startApp(buildApp());

    const response = await fetch(`${baseUrl}/sync`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer fake-token" },
      body: JSON.stringify({
        creatorId: "creator-1",
        provider: "instagram",
        windowFrom: "2026-09-01T00:00:00.000Z",
        windowTo: "2026-10-01T00:00:00.000Z",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      synced: 2,
      deduplicated: 0,
      retries: 0,
    });
  });

  it("lists synced posts with the fetch timestamp", async () => {
    const baseUrl = await startApp(buildApp());

    await fetch(`${baseUrl}/sync`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer fake-token" },
      body: JSON.stringify({
        creatorId: "creator-1",
        provider: "instagram",
        windowFrom: "2026-09-01T00:00:00.000Z",
        windowTo: "2026-10-01T00:00:00.000Z",
      }),
    });

    const response = await fetch(`${baseUrl}/creators/creator-1/posts`, {
      headers: { authorization: "Bearer fake-token" },
    });
    expect(response.status).toBe(200);
    const posts = (await response.json()) as Array<{ fetchedAt: string }>;
    expect(posts).toHaveLength(2);
    for (const post of posts) {
      expect(post.fetchedAt).toBe(FIXED_NOW);
    }
  });

  it("treats the window as [from, to), excluding posts at the upper bound", async () => {
    const baseUrl = await startApp(buildApp());

    const response = await fetch(`${baseUrl}/sync`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer fake-token" },
      body: JSON.stringify({
        creatorId: "creator-1",
        provider: "instagram",
        windowFrom: "2026-09-01T00:00:00.000Z",
        windowTo: "2026-09-12T10:00:00.000Z",
      }),
    });

    expect(await response.json()).toEqual({
      synced: 1,
      deduplicated: 0,
      retries: 0,
    });
  });
});
