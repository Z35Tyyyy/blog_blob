import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import type { PostSummary } from '../types';

export default function Posts({ demo }: { demo: boolean }) {
  const [posts, setPosts] = useState<PostSummary[] | null>(null);
  const [error, setError] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'draft' | 'published'>('all');
  const navigate = useNavigate();

  const load = () => {
    api.listPosts().then(setPosts).catch((e) => setError(e.message));
  };
  useEffect(load, []);

  const create = async () => {
    if (busy) return; // double Enter/click would create duplicate drafts
    const t = title.trim() || 'Untitled';
    setBusy(true);
    try {
      const post = await api.createPost(t);
      navigate(`/edit/${post.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const remove = async (p: PostSummary) => {
    if (!window.confirm(`delete draft “${p.title}”? this cannot be undone.`)) return;
    try {
      await api.deletePost(p.id);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const q = query.trim().toLowerCase();
  const shown = (posts ?? []).filter(
    (p) =>
      (filter === 'all' || p.status === filter) &&
      (!q ||
        p.title.toLowerCase().includes(q) ||
        p.slug.includes(q) ||
        p.tags.some((t) => t.includes(q)))
  );

  return (
    <main className="page">
      {!demo && (
        <div className="new-post">
          <input
            placeholder="new post title…"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
          />
          <button onClick={create} disabled={busy}>{busy ? '…' : '+ new post'}</button>
        </div>
      )}

      {error && <p className="error">{error}</p>}
      {!posts && !error && <p className="muted">loading…</p>}
      {posts && posts.length === 0 && (
        <p className="muted">no posts yet. the empty page is undefeated — go write something.</p>
      )}

      {posts && posts.length > 0 && (
        <div className="filter-row">
          <input
            placeholder="search title, slug, tag…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {(['all', 'draft', 'published'] as const).map((f) => (
            <button
              key={f}
              className={`ghost tool ${filter === f ? 'active' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>
      )}

      {posts && posts.length > 0 && shown.length === 0 && (
        <p className="muted">nothing matches that search.</p>
      )}

      {shown.length > 0 && (
        <ul className="post-list">
          {shown.map((p) => (
            <li key={p.id} className="post-row" onClick={() => navigate(`/edit/${p.id}`)}>
              <div className="post-row-main">
                <span className="post-row-title">{p.title || 'Untitled'}</span>
                <span className="post-row-slug muted">/{p.slug}</span>
                {p.tags.length > 0 && (
                  <span className="post-row-tags muted">{p.tags.map((t) => `#${t}`).join(' ')}</span>
                )}
              </div>
              <div className="post-row-side">
                <span className={`pill pill-${p.status}`}>{p.status}</span>
                <span className="muted post-row-date">{p.date}</span>
                {p.status === 'draft' && !demo && (
                  <button
                    className="ghost danger"
                    onClick={(e) => {
                      e.stopPropagation();
                      remove(p);
                    }}
                    title="delete draft"
                  >
                    ✕
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
