import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { createApp } from "../src/app";
import { MemoryStore } from "../src/adapters/memoryStore";
import { FakeProvider } from "../src/adapters/fakeProvider";
import { SyncExhaustedError } from "../src/ports";
import { syncCreatorMetrics } from "../src/domain/syncService";
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

class FakeClock {
  current: number;
  constructor(start: string) {
    this.current = Date.parse(start);
  }
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

class FakeSleeper {
  readonly waits: number[] = [];
  constructor(private readonly clock: FakeClock) {}
  async sleep(ms: number): Promise<void> {
    this.waits.push(ms);
    this.clock.advance(ms);
  }
}

const SYNC_BODY = JSON.stringify({
  creatorId: "creator-1",
  provider: "instagram",
  windowFrom: "2026-09-01T00:00:00.000Z",
  windowTo: "2026-10-01T00:00:00.000Z",
});

function serviceDeps(
  provider: FakeProvider,
  clock: FakeClock,
  sleeper: FakeSleeper,
) {
  return {
    provider,
    store: new MemoryStore(["creator-1"]),
    clock,
    sleeper,
  };
}

describe("sync retry on timeout and 429", () => {
  it("retries a timeout once with a 1s wait", async () => {
    const clock = new FakeClock("2026-10-01T12:00:00.000Z");
    const sleeper = new FakeSleeper(clock);
    const baseUrl = await startApp(
      createApp(
        serviceDeps(
          new FakeProvider(POSTS, { failures: ["timeout"] }),
          clock,
          sleeper,
        ),
      ),
    );

    const response = await fetch(`${baseUrl}/sync`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer fake-token" },
      body: SYNC_BODY,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      synced: 1,
      deduplicated: 0,
      retries: 1,
    });
    expect(sleeper.waits).toEqual([1000]);
  });

  it("waits the provider Retry-After on 429", async () => {
    const clock = new FakeClock("2026-10-01T12:00:00.000Z");
    const sleeper = new FakeSleeper(clock);
    const baseUrl = await startApp(
      createApp(
        serviceDeps(
          new FakeProvider(POSTS, {
            failures: ["rate-limited"],
            retryAfterSeconds: 5,
          }),
          clock,
          sleeper,
        ),
      ),
    );

    const response = await fetch(`${baseUrl}/sync`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer fake-token" },
      body: SYNC_BODY,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      synced: 1,
      deduplicated: 0,
      retries: 1,
    });
    expect(sleeper.waits).toEqual([5000]);
  });

  it("caps the 429 wait at the configured ceiling", async () => {
    const clock = new FakeClock("2026-10-01T12:00:00.000Z");
    const sleeper = new FakeSleeper(clock);
    const baseUrl = await startApp(
      createApp(
        serviceDeps(
          new FakeProvider(POSTS, {
            failures: ["rate-limited"],
            retryAfterSeconds: 120,
          }),
          clock,
          sleeper,
        ),
      ),
    );

    const response = await fetch(`${baseUrl}/sync`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer fake-token" },
      body: SYNC_BODY,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      synced: 1,
      deduplicated: 0,
      retries: 1,
    });
    expect(sleeper.waits).toEqual([30000]);
  });

  it.each([null, 0, -5])(
    "treats missing or invalid Retry-After (%s) as a plain timeout",
    async (retryAfterSeconds) => {
      const clock = new FakeClock("2026-10-01T12:00:00.000Z");
      const sleeper = new FakeSleeper(clock);
      const baseUrl = await startApp(
        createApp(
          serviceDeps(
            new FakeProvider(POSTS, {
              failures: ["rate-limited"],
              retryAfterSeconds: retryAfterSeconds as number | null,
            }),
            clock,
            sleeper,
          ),
        ),
      );

      const response = await fetch(`${baseUrl}/sync`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer fake-token" },
        body: SYNC_BODY,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        synced: 1,
        deduplicated: 0,
        retries: 1,
      });
      expect(sleeper.waits).toEqual([1000]);
    },
  );

  it("stops after at most 5 provider calls without looping", async () => {
    const clock = new FakeClock("2026-10-01T12:00:00.000Z");
    const sleeper = new FakeSleeper(clock);
    const provider = new FakeProvider(POSTS, {
      failures: ["timeout", "timeout", "timeout", "timeout", "timeout", "timeout"],
    });

    const failed = await syncCreatorMetrics(
      serviceDeps(provider, clock, sleeper),
      {
        creatorId: "creator-1",
        provider: "instagram",
        windowFrom: "2026-09-01T00:00:00.000Z",
        windowTo: "2026-10-01T00:00:00.000Z",
      },
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failed).toBeInstanceOf(SyncExhaustedError);
    expect((failed as SyncExhaustedError).retries).toBe(4);
    expect(provider.calls).toBe(5);
    expect(sleeper.waits).toEqual([1000, 1000, 1000, 1000]);
  });

  it("stamps fetchedAt after the final successful retry", async () => {
    const clock = new FakeClock("2026-10-01T12:00:00.000Z");
    const sleeper = new FakeSleeper(clock);
    const baseUrl = await startApp(
      createApp(
        serviceDeps(
          new FakeProvider(POSTS, {
            failures: ["rate-limited"],
            retryAfterSeconds: 5,
          }),
          clock,
          sleeper,
        ),
      ),
    );

    await fetch(`${baseUrl}/sync`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer fake-token" },
      body: SYNC_BODY,
    });

    const posts = (await (
      await fetch(`${baseUrl}/creators/creator-1/posts`, {
        headers: { authorization: "Bearer fake-token" },
      })
    ).json()) as Array<{ fetchedAt: string }>;
    expect(posts).toHaveLength(1);
    expect(posts[0].fetchedAt).toBe("2026-10-01T12:00:05.000Z");
  });
});
