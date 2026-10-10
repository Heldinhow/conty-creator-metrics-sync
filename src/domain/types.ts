export type Provider = "instagram" | "tiktok" | "youtube" | "x";

export interface PostSnapshot {
  provider: Provider;
  postId: string;
  publishedAt: string;
  likes: number;
  comments: number;
  shares: number;
  views: number;
}

export interface StoredPost extends PostSnapshot {
  fetchedAt: string;
}

export interface SyncInput {
  creatorId: string;
  provider: Provider;
  windowFrom: string;
  windowTo: string;
}

export interface SyncStats {
  synced: number;
  deduplicated: number;
  retries: number;
}
