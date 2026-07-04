import { Router } from 'express';
import { db } from './db.js';
import { localDate, slugify } from './markdown.js';

export const postsRouter = Router();

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const summaryCols =
  'id, slug, title, description, tags, cover, status, date, created_at, updated_at, published_at';

function serialize(row) {
  if (!row) return row;
  return { ...row, tags: JSON.parse(row.tags || '[]') };
}

function uniqueSlug(base, excludeId = -1) {
  let slug = base;
  let n = 2;
  while (db.prepare('SELECT id FROM posts WHERE slug = ? AND id != ?').get(slug, excludeId)) {
    slug = `${base}-${n++}`;
  }
  return slug;
}

postsRouter.get('/', (req, res) => {
  const rows = db.prepare(`SELECT ${summaryCols} FROM posts ORDER BY updated_at DESC`).all();
  res.json(rows.map(serialize));
});

postsRouter.post('/', (req, res) => {
  const title = String(req.body?.title ?? 'Untitled').slice(0, 200) || 'Untitled';
  const slug = uniqueSlug(slugify(title));
  const date = localDate();
  const info = db
    .prepare('INSERT INTO posts (slug, title, date) VALUES (?, ?, ?)')
    .run(slug, title, date);
  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(serialize(row));
});

postsRouter.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'post not found' });
  res.json(serialize(row));
});

postsRouter.put('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'post not found' });

  const b = req.body ?? {};
  const title = String(b.title ?? row.title).slice(0, 200);
  const description = String(b.description ?? row.description).slice(0, 500);
  const markdown = String(b.markdown ?? row.markdown);
  const cover = String(b.cover ?? row.cover).slice(0, 500);
  const date = String(b.date ?? row.date);

  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }

  let tags = row.tags;
  if (b.tags !== undefined) {
    if (!Array.isArray(b.tags) || b.tags.some((t) => typeof t !== 'string')) {
      return res.status(400).json({ error: 'tags must be an array of strings' });
    }
    tags = JSON.stringify(b.tags.map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 10));
  }

  let slug = row.slug;
  if (b.slug !== undefined && b.slug !== row.slug) {
    const wanted = String(b.slug).toLowerCase();
    if (!SLUG_RE.test(wanted)) {
      return res.status(400).json({ error: 'slug: lowercase letters, digits, hyphens' });
    }
    if (row.status === 'published') {
      return res.status(400).json({ error: 'unpublish before changing the slug of a published post' });
    }
    slug = uniqueSlug(wanted, row.id);
  }

  db.prepare(
    `UPDATE posts SET slug=?, title=?, description=?, tags=?, cover=?, markdown=?, date=?,
     updated_at=datetime('now') WHERE id=?`
  ).run(slug, title, description, tags, cover, markdown, date, row.id);

  res.json(serialize(db.prepare('SELECT * FROM posts WHERE id = ?').get(row.id)));
});

postsRouter.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'post not found' });
  if (row.status === 'published') {
    return res.status(400).json({ error: 'unpublish this post before deleting it' });
  }
  db.prepare('DELETE FROM posts WHERE id = ?').run(row.id);
  res.json({ ok: true });
});
