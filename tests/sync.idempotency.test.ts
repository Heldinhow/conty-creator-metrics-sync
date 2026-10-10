import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { createApp } from "../src/app";
import { MemoryStore } from "../src/adapters/memoryStore";
import { FakeProvider } from "../src/adapters/fakeProvider";
import type { PostSnapshot } from "../src/domain/types";

const FIRST_SYNC_AT = "2026-10-01T12:00:00.000Z";
const SECOND_SYNC_AT = "2026-10-02T12:00:00.000Z";

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
    publishedAt: "2026-09-20T10:00:00.000Z",
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

describe("sync idempotency", () => {
  it("does not double count the same snapshot synced twice", async () => {
    let currentTime = FIRST_SYNC_AT;
    const baseUrl = await startApp(
      createApp({
        provider: new FakeProvider(POSTS),
        store: new MemoryStore(["creator-1"]),
        clock: { now: () => new Date(currentTime) },
        sleeper: { sleep: async () => {} },
      }),
    );
    const body = JSON.stringify({
      creatorId: "creator-1",
      provider: "instagram",
      windowFrom: "2026-09-01T00:00:00.000Z",
      windowTo: "2026-10-01T00:00:00.000Z",
    });

    const first = await (
      await fetch(`${baseUrl}/sync`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer fake-token" },
        body,
      })
    ).json();
    expect(first).toEqual({ synced: 2, deduplicated: 0, retries: 0 });

    currentTime = SECOND_SYNC_AT;
    const second = await (
      await fetch(`${baseUrl}/sync`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer fake-token" },
        body,
      })
    ).json();
    expect(second).toEqual({ synced: 0, deduplicated: 2, retries: 0 });

    const posts = (await (
      await fetch(`${baseUrl}/creators/creator-1/posts`, {
        headers: { authorization: "Bearer fake-token" },
      })
    ).json()) as Array<{ postId: string; fetchedAt: string }>;
    expect(posts).toHaveLength(2);
    for (const post of posts) {
      expect(post.fetchedAt).toBe(SECOND_SYNC_AT);
    }
  });

  it("does not double count overlapping windows", async () => {
    const baseUrl = await startApp(
      createApp({
        provider: new FakeProvider(POSTS),
        store: new MemoryStore(["creator-1"]),
        clock: { now: () => new Date(FIRST_SYNC_AT) },
        sleeper: { sleep: async () => {} },
      }),
    );
    const sync = (windowFrom: string, windowTo: string) =>
      fetch(`${baseUrl}/sync`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer fake-token" },
        body: JSON.stringify({
          creatorId: "creator-1",
          provider: "instagram",
          windowFrom,
          windowTo,
        }),
      }).then((response) => response.json());

    const first = await sync(
      "2026-09-01T00:00:00.000Z",
      "2026-09-15T00:00:00.000Z",
    );
    expect(first).toEqual({ synced: 1, deduplicated: 0, retries: 0 });

    const second = await sync(
      "2026-09-10T00:00:00.000Z",
      "2026-10-01T00:00:00.000Z",
    );
    expect(second).toEqual({ synced: 1, deduplicated: 1, retries: 0 });

    const posts = (await (
      await fetch(`${baseUrl}/creators/creator-1/posts`, {
        headers: { authorization: "Bearer fake-token" },
      })
    ).json()) as unknown[];
    expect(posts).toHaveLength(2);
  });

  it("counts duplicates inside a single response as deduplicated", async () => {
    const baseUrl = await startApp(
      createApp({
        provider: new FakeProvider(POSTS, { duplicate: true }),
        store: new MemoryStore(["creator-1"]),
        clock: { now: () => new Date(FIRST_SYNC_AT) },
        sleeper: { sleep: async () => {} },
      }),
    );

    const result = await (
      await fetch(`${baseUrl}/sync`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer fake-token" },
        body: JSON.stringify({
          creatorId: "creator-1",
          provider: "instagram",
          windowFrom: "2026-09-01T00:00:00.000Z",
          windowTo: "2026-09-11T00:00:00.000Z",
        }),
      })
    ).json();

    expect(result).toEqual({ synced: 1, deduplicated: 1, retries: 0 });
  });

  it("overwrites the snapshot on repeat with new metrics but still counts deduplicated", async () => {
    const mutablePosts = POSTS.map((post) => ({ ...post }));
    const baseUrl = await startApp(
      createApp({
        provider: new FakeProvider(mutablePosts),
        store: new MemoryStore(["creator-1"]),
        clock: { now: () => new Date(FIRST_SYNC_AT) },
        sleeper: { sleep: async () => {} },
      }),
    );
    const body = JSON.stringify({
      creatorId: "creator-1",
      provider: "instagram",
      windowFrom: "2026-09-01T00:00:00.000Z",
      windowTo: "2026-09-11T00:00:00.000Z",
    });
    const sync = () =>
      fetch(`${baseUrl}/sync`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer fake-token" },
        body,
      }).then((response) => response.json());

    await sync();
    mutablePosts[0].likes = 999;
    const repeat = await sync();
    expect(repeat).toEqual({ synced: 0, deduplicated: 1, retries: 0 });

    const posts = (await (
      await fetch(`${baseUrl}/creators/creator-1/posts?provider=instagram`, {
        headers: { authorization: "Bearer fake-token" },
      })
    ).json()) as Array<{ postId: string; likes: number }>;
    expect(posts.find((post) => post.postId === "post-1")?.likes).toBe(999);
  });
});
