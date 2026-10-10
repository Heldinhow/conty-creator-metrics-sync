import type { PostSnapshot, Provider, StoredPost, SyncInput } from "./domain/types";

export class ProviderTimeoutError extends Error {
  constructor() {
    super("Provider request timed out");
    this.name = "ProviderTimeoutError";
  }
}

export class RateLimitedError extends Error {
  readonly retryAfterSeconds: number | null;

  constructor(retryAfterSeconds: number | null) {
    super("Provider rate limit exceeded");
    this.name = "RateLimitedError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class SyncExhaustedError extends Error {
  readonly retries: number;
  readonly retryAfterSeconds: number | null;

  constructor(retries: number, retryAfterSeconds: number | null) {
    super("Sync retries exhausted");
    this.name = "SyncExhaustedError";
    this.retries = retries;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface SyncLimits {
  maxAttempts: number;
  maxWaitMs: number;
  timeoutBackoffMs: number;
}
export type SyncInputErrorCode = "INVALID_WINDOW" | "UNKNOWN_PROVIDER";

export class InvalidSyncInputError extends Error {
  readonly code: SyncInputErrorCode;

  constructor(code: SyncInputErrorCode) {
    super(code === "INVALID_WINDOW" ? "Invalid sync window" : "Unknown provider");
    this.name = "InvalidSyncInputError";
    this.code = code;
  }
}

export class CreatorNotFoundError extends Error {
  constructor() {
    super("Creator not found");
    this.name = "CreatorNotFoundError";
  }
}

export interface FetchWindow {
  provider: Provider;
  from: string;
  to: string;
}

export interface ProviderClient {
  fetchPosts(window: FetchWindow): Promise<PostSnapshot[]>;
}

export interface MetricsStore {
  hasCreator(creatorId: string): boolean;
  upsert(creatorId: string, post: StoredPost): "inserted" | "updated";
  list(creatorId: string, provider?: Provider): StoredPost[];
}

export interface Clock {
  now(): Date;
}

export interface Sleeper {
  sleep(ms: number): Promise<void>;
}

export interface SyncDependencies {
  provider: ProviderClient;
  store: MetricsStore;
  clock: Clock;
  sleeper: Sleeper;
  limits?: SyncLimits;
}

export type { SyncInput };
