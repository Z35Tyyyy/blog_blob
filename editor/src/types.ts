export interface PostSummary {
  id: string;
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
  publish_at: string | null;
}

export interface Post extends PostSummary {
  markdown: string;
}

export interface RevisionSummary {
  id: string;
  words: number;
  created_at: string;
}

export interface Revision extends RevisionSummary {
  title: string;
  markdown: string;
}

export interface AuthStatus {
  setupNeeded: boolean;
  setupTokenRequired: boolean;
  authenticated: boolean;
  username: string | null;
  demo: boolean;
}

export interface Settings {
  owner: string;
  repo: string;
  branch: string;
  authorName: string;
  siteUrl: string;
}

export interface PublishResult {
  ok: boolean;
  queued: boolean;
  slug: string;
}
