import type { FetchWindow, ProviderClient } from "../ports";
import { ProviderTimeoutError, RateLimitedError } from "../ports";
import type { PostSnapshot } from "../domain/types";

export type FakeFailure = "timeout" | "rate-limited";

export interface FakeProviderOptions {
  duplicate?: boolean;
  failures?: FakeFailure[];
  retryAfterSeconds?: number | null;
}

export class FakeProvider implements ProviderClient {
  private readonly posts: PostSnapshot[];
  private readonly duplicate: boolean;
  private readonly failures: FakeFailure[];
  private readonly retryAfterSeconds: number | null;
  calls = 0;

  constructor(posts: PostSnapshot[], options: FakeProviderOptions = {}) {
    this.posts = posts;
    this.duplicate = options.duplicate ?? false;
    this.failures = [...(options.failures ?? [])];
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }

  async fetchPosts(window: FetchWindow): Promise<PostSnapshot[]> {
    this.calls += 1;
    const next = this.failures.shift();
    if (next === "timeout") {
      throw new ProviderTimeoutError();
    }
    if (next === "rate-limited") {
      throw new RateLimitedError(this.retryAfterSeconds);
    }
    const matched = this.posts.filter(
      (post) =>
        post.provider === window.provider &&
        post.publishedAt >= window.from &&
        post.publishedAt < window.to,
    );
    if (this.duplicate && matched.length > 0) {
      return [...matched, { ...matched[0] }];
    }
    return matched;
  }
}
