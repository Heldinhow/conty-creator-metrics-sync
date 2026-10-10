import type { SyncDependencies, SyncInput } from "../ports";
import {
  CreatorNotFoundError,
  InvalidSyncInputError,
  ProviderTimeoutError,
  RateLimitedError,
  SyncExhaustedError,
} from "../ports";
import type { PostSnapshot, Provider, SyncStats } from "./types";

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_MAX_WAIT_MS = 30000;
const DEFAULT_TIMEOUT_BACKOFF_MS = 1000;

const KNOWN_PROVIDERS: readonly Provider[] = [
  "instagram",
  "tiktok",
  "youtube",
  "x",
];

function isUsableRetryAfter(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function validateInput(input: SyncInput): void {
  if (!KNOWN_PROVIDERS.includes(input.provider)) {
    throw new InvalidSyncInputError("UNKNOWN_PROVIDER");
  }
  const from = Date.parse(input.windowFrom);
  const to = Date.parse(input.windowTo);
  if (Number.isNaN(from) || Number.isNaN(to) || from >= to) {
    throw new InvalidSyncInputError("INVALID_WINDOW");
  }
}

export async function syncCreatorMetrics(
  deps: SyncDependencies,
  input: SyncInput,
): Promise<SyncStats> {
  const maxAttempts = deps.limits?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxWaitMs = deps.limits?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const timeoutBackoffMs =
    deps.limits?.timeoutBackoffMs ?? DEFAULT_TIMEOUT_BACKOFF_MS;

  validateInput(input);
  if (!deps.store.hasCreator(input.creatorId)) {
    throw new CreatorNotFoundError();
  }

  let retries = 0;
  let suggestedRetryAfter: number | null = null;
  let posts: PostSnapshot[] | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      posts = await deps.provider.fetchPosts({
        provider: input.provider,
        from: input.windowFrom,
        to: input.windowTo,
      });
      break;
    } catch (error) {
      if (attempt >= maxAttempts) {
        throw new SyncExhaustedError(retries, suggestedRetryAfter);
      }
      if (
        error instanceof RateLimitedError &&
        isUsableRetryAfter(error.retryAfterSeconds)
      ) {
        suggestedRetryAfter = error.retryAfterSeconds;
        await deps.sleeper.sleep(
          Math.min(error.retryAfterSeconds * 1000, maxWaitMs),
        );
        retries += 1;
      } else if (
        error instanceof RateLimitedError ||
        error instanceof ProviderTimeoutError
      ) {
        await deps.sleeper.sleep(timeoutBackoffMs);
        retries += 1;
      } else {
        throw error;
      }
    }
  }

  const fetchedAt = deps.clock.now().toISOString();
  let synced = 0;
  let deduplicated = 0;
  const seen = new Set<string>();
  for (const post of posts ?? []) {
    const key = `${post.provider}:${post.postId}`;
    if (seen.has(key)) {
      deduplicated += 1;
      continue;
    }
    seen.add(key);
    const outcome = deps.store.upsert(input.creatorId, { ...post, fetchedAt });
    if (outcome === "inserted") {
      synced += 1;
    } else {
      deduplicated += 1;
    }
  }
  return { synced, deduplicated, retries };
}
