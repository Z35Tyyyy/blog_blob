import type { AuthStatus, Post, PostSummary, PublishResult, Settings } from './types';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: init?.body && !(init.body instanceof FormData)
      ? { 'Content-Type': 'application/json' }
      : undefined,
    ...init,
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch {
      /* not json */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export const api = {
  // auth
  status: () => request<AuthStatus>('/api/status'),
  setup: (username: string, password: string) =>
    request<{ ok: boolean }>('/api/setup', { method: 'POST', body: JSON.stringify({ username, password }) }),
  login: (username: string, password: string) =>
    request<{ ok: boolean }>('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request<{ ok: boolean }>('/api/logout', { method: 'POST' }),

  // posts
  listPosts: () => request<PostSummary[]>('/api/posts'),
  createPost: (title: string) =>
    request<Post>('/api/posts', { method: 'POST', body: JSON.stringify({ title }) }),
  getPost: (id: number | string) => request<Post>(`/api/posts/${id}`),
  updatePost: (id: number, patch: Partial<Post>) =>
    request<Post>(`/api/posts/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deletePost: (id: number) => request<{ ok: boolean }>(`/api/posts/${id}`, { method: 'DELETE' }),
  publish: (id: number) => request<PublishResult>(`/api/posts/${id}/publish`, { method: 'POST' }),
  unpublish: (id: number) => request<{ ok: boolean }>(`/api/posts/${id}/unpublish`, { method: 'POST' }),

  // uploads
  upload: (file: File) => {
    const form = new FormData();
    form.append('image', file);
    return request<{ url: string }>('/api/uploads', { method: 'POST', body: form });
  },

  // settings
  getSettings: () => request<Settings>('/api/settings'),
  saveSettings: (patch: Partial<Settings> & { githubToken?: string | null }) =>
    request<{ ok: boolean }>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  testSettings: () =>
    request<{ ok: boolean; fullName: string; canPush: boolean }>('/api/settings/test', { method: 'POST' }),
};
