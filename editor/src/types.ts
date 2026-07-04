export interface PostSummary {
  id: number;
  slug: string;
  title: string;
  description: string;
  tags: string[];
  cover: string;
  status: 'draft' | 'published';
  date: string;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}

export interface Post extends PostSummary {
  markdown: string;
}

export interface AuthStatus {
  setupNeeded: boolean;
  authenticated: boolean;
  username: string | null;
}

export interface Settings {
  owner: string;
  repo: string;
  branch: string;
  authorName: string;
  hasToken: boolean;
}

export interface PublishResult {
  ok: boolean;
  commit: string;
  slug: string;
  rawUrl: string;
}
