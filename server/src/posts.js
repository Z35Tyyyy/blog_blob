import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { db } from './db.js';
import { localDate, slugify } from './markdown.js';

export const postsRouter = Router();

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function oid(value) {
  return ObjectId.isValid(String(value)) ? new ObjectId(String(value)) : null;
}

export function serialize(doc, { includeMarkdown = true } = {}) {
  if (!doc) return doc;
  const out = {
    id: doc._id.toString(),
    slug: doc.slug,
    title: doc.title,
    description: doc.description,
    tags: doc.tags ?? [],
    cover: doc.cover,
    status: doc.status,
    date: doc.date,
    created_at: doc.createdAt?.toISOString() ?? null,
    updated_at: doc.updatedAt?.toISOString() ?? null,
    published_at: doc.publishedAt?.toISOString() ?? null,
  };
  if (includeMarkdown) out.markdown = doc.markdown;
  return out;
}

async function uniqueSlug(base, excludeId = null) {
  let slug = base;
  let n = 2;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const clash = await db
      .collection('posts')
      .findOne({ slug, ...(excludeId ? { _id: { $ne: excludeId } } : {}) }, { projection: { _id: 1 } });
    if (!clash) return slug;
    slug = `${base}-${n++}`;
  }
}

postsRouter.get('/', async (req, res, next) => {
  try {
    const docs = await db.collection('posts').find({}).sort({ updatedAt: -1 }).toArray();
    res.json(docs.map((d) => serialize(d, { includeMarkdown: false })));
  } catch (err) {
    next(err);
  }
});

postsRouter.post('/', async (req, res, next) => {
  try {
    const title = String(req.body?.title ?? 'Untitled').slice(0, 200) || 'Untitled';
    const slug = await uniqueSlug(slugify(title));
    const now = new Date();
    const doc = {
      slug,
      title,
      description: '',
      tags: [],
      cover: '',
      markdown: '',
      status: 'draft',
      date: localDate(),
      createdAt: now,
      updatedAt: now,
      publishedAt: null,
      publishedJson: null,
    };
    const info = await db.collection('posts').insertOne(doc);
    res.status(201).json(serialize({ ...doc, _id: info.insertedId }));
  } catch (err) {
    next(err);
  }
});

postsRouter.get('/:id', async (req, res, next) => {
  try {
    const _id = oid(req.params.id);
    const doc = _id && (await db.collection('posts').findOne({ _id }));
    if (!doc) return res.status(404).json({ error: 'post not found' });
    res.json(serialize(doc));
  } catch (err) {
    next(err);
  }
});

postsRouter.put('/:id', async (req, res, next) => {
  try {
    const _id = oid(req.params.id);
    const doc = _id && (await db.collection('posts').findOne({ _id }));
    if (!doc) return res.status(404).json({ error: 'post not found' });

    const b = req.body ?? {};
    const patch = {
      title: String(b.title ?? doc.title).slice(0, 200),
      description: String(b.description ?? doc.description).slice(0, 500),
      markdown: String(b.markdown ?? doc.markdown),
      cover: String(b.cover ?? doc.cover).slice(0, 500),
      date: String(b.date ?? doc.date),
      updatedAt: new Date(),
    };

    if (patch.date && !/^\d{4}-\d{2}-\d{2}$/.test(patch.date)) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    }

    if (b.tags !== undefined) {
      if (!Array.isArray(b.tags) || b.tags.some((t) => typeof t !== 'string')) {
        return res.status(400).json({ error: 'tags must be an array of strings' });
      }
      patch.tags = b.tags.map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 10);
    }

    if (b.slug !== undefined && b.slug !== doc.slug) {
      const wanted = String(b.slug).toLowerCase();
      if (!SLUG_RE.test(wanted)) {
        return res.status(400).json({ error: 'slug: lowercase letters, digits, hyphens' });
      }
      if (doc.status === 'published') {
        return res.status(400).json({ error: 'unpublish before changing the slug of a published post' });
      }
      patch.slug = await uniqueSlug(wanted, doc._id);
    }

    await db.collection('posts').updateOne({ _id }, { $set: patch });
    res.json(serialize(await db.collection('posts').findOne({ _id })));
  } catch (err) {
    next(err);
  }
});

postsRouter.delete('/:id', async (req, res, next) => {
  try {
    const _id = oid(req.params.id);
    const doc = _id && (await db.collection('posts').findOne({ _id }));
    if (!doc) return res.status(404).json({ error: 'post not found' });
    if (doc.status === 'published') {
      return res.status(400).json({ error: 'unpublish this post before deleting it' });
    }
    await db.collection('posts').deleteOne({ _id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
