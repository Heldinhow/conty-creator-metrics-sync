import express, { type Express, type Request, type Response } from "express";
import { syncCreatorMetrics } from "./domain/syncService";
import { FakeProvider } from "./adapters/fakeProvider";
import { MemoryStore } from "./adapters/memoryStore";
import {
  CreatorNotFoundError,
  InvalidSyncInputError,
  SyncExhaustedError,
  type SyncDependencies,
} from "./ports";
import type { PostSnapshot, Provider } from "./domain/types";

const DEMO_CREATOR_ID = "creator-1";

const DEMO_POSTS: PostSnapshot[] = [
  {
    provider: "instagram",
    postId: "demo-ig-1",
    publishedAt: "2026-09-10T10:00:00.000Z",
    likes: 120,
    comments: 8,
    shares: 3,
    views: 1500,
  },
  {
    provider: "tiktok",
    postId: "demo-tt-1",
    publishedAt: "2026-09-11T10:00:00.000Z",
    likes: 980,
    comments: 64,
    shares: 120,
    views: 22000,
  },
  {
    provider: "youtube",
    postId: "demo-yt-1",
    publishedAt: "2026-09-12T10:00:00.000Z",
    likes: 450,
    comments: 30,
    shares: 12,
    views: 9800,
  },
  {
    provider: "x",
    postId: "demo-x-1",
    publishedAt: "2026-09-13T10:00:00.000Z",
    likes: 210,
    comments: 15,
    shares: 40,
    views: 5300,
  },
];

const KNOWN_PROVIDERS: readonly string[] = [
  "instagram",
  "tiktok",
  "youtube",
  "x",
];

function isAuthorized(req: Request): boolean {
  const header = req.header("authorization");
  return (
    header !== undefined &&
    header.toLowerCase().startsWith("bearer ") &&
    header.length > "bearer ".length
  );
}

export function createApp(deps: SyncDependencies): Express {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use((req, res, next) => {
    if (!isAuthorized(req)) {
      res.status(401).json({ error: "UNAUTHORIZED" });
      return;
    }
    next();
  });

  app.post("/sync", async (req, res) => {
    try {
      const stats = await syncCreatorMetrics(deps, {
        creatorId: req.body.creatorId,
        provider: req.body.provider,
        windowFrom: req.body.windowFrom,
        windowTo: req.body.windowTo,
      });
      res.json(stats);
    } catch (error) {
      sendSyncError(res, error);
    }
  });

  app.get("/creators/:id/posts", (req, res) => {
    if (!deps.store.hasCreator(req.params.id)) {
      res.status(404).json({ error: "CREATOR_NOT_FOUND" });
      return;
    }
    const provider = req.query.provider as string | undefined;
    if (provider !== undefined && !KNOWN_PROVIDERS.includes(provider)) {
      res.status(400).json({ error: "UNKNOWN_PROVIDER" });
      return;
    }
    res.json(deps.store.list(req.params.id, provider as Provider | undefined));
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "NOT_FOUND" });
  });

  return app;
}

function sendSyncError(res: Response, error: unknown): void {
  if (error instanceof InvalidSyncInputError) {
    res.status(400).json({ error: error.code });
    return;
  }
  if (error instanceof CreatorNotFoundError) {
    res.status(404).json({ error: "CREATOR_NOT_FOUND" });
    return;
  }
  if (error instanceof SyncExhaustedError) {
    res.status(502).json({
      error: "SYNC_EXHAUSTED",
      retries: error.retries,
      retryAfterSeconds: error.retryAfterSeconds,
    });
    return;
  }
  res.status(500).json({ error: "INTERNAL_ERROR" });
}

export function createDefaultApp(): Express {
  return createApp({
    provider: new FakeProvider(DEMO_POSTS),
    store: new MemoryStore([DEMO_CREATOR_ID]),
    clock: { now: () => new Date() },
    sleeper: {
      sleep: (ms: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, ms)),
    },
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT ?? 3000);
  createDefaultApp().listen(port);
}
