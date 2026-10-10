import type { MetricsStore } from "../ports";
import type { Provider, StoredPost } from "../domain/types";

export class MemoryStore implements MetricsStore {
  private readonly creators = new Set<string>();
  private readonly posts = new Map<string, StoredPost>();

  constructor(seedCreatorIds: string[] = []) {
    for (const id of seedCreatorIds) {
      this.creators.add(id);
    }
  }

  hasCreator(creatorId: string): boolean {
    return this.creators.has(creatorId);
  }

  upsert(creatorId: string, post: StoredPost): "inserted" | "updated" {
    const key = `${creatorId}:${post.provider}:${post.postId}`;
    const outcome = this.posts.has(key) ? "updated" : "inserted";
    this.posts.set(key, post);
    return outcome;
  }

  list(creatorId: string, provider?: Provider): StoredPost[] {
    const prefix = `${creatorId}:`;
    const result: StoredPost[] = [];
    for (const [key, post] of this.posts) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      if (provider !== undefined && post.provider !== provider) {
        continue;
      }
      result.push(post);
    }
    return result;
  }
}
