import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { db } from './db.js';
import { readUploadBase64 } from './uploads.js';

export const exportRouter = Router();

// Authenticated by a shared key (EXPORT_KEY env var), not a session: the
// caller is the sync-content GitHub Actions workflow. The key only guards
// already-public published content, so a leak is low-severity — but it keeps
// GridFS reads from being an open endpoint.
function keyOk(req) {
  const configured = process.env.EXPORT_KEY || '';
  const header = req.headers.authorization || '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!configured || !given) return false;
  const a = Buffer.from(configured);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The desired state of the repo's content/ tree, built purely from
 * publish-time snapshots. The sync workflow reconciles content/ to match,
 * so publish, republish, unpublish and image pruning are all just
 * "make the tree equal the manifest".
 */
exportRouter.get('/content', async (req, res, next) => {
  try {
    if (!process.env.EXPORT_KEY) {
      return res.status(503).json({ error: 'EXPORT_KEY not configured on the server' });
    }
    if (!keyOk(req)) return res.status(401).json({ error: 'bad export key' });

    const rows = await db
      .collection('posts')
      .find(
        { status: 'published', publishedJson: { $ne: null } },
        { projection: { slug: 1, publishedJson: 1, publishedMarkdown: 1, publishedImages: 1 } }
      )
      .toArray();

    const entries = rows
      .map((r) => JSON.parse(r.publishedJson))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

    const files = [
      { path: 'content/posts.json', content: JSON.stringify(entries, null, 2) + '\n' },
    ];
    for (const r of rows) {
      if (typeof r.publishedMarkdown !== 'string') {
        // pre-snapshot post (published by the old direct-commit flow):
        // republishing regenerates the snapshot
        return res
          .status(500)
          .json({ error: `post "${r.slug}" has no published-markdown snapshot — republish it` });
      }
      files.push({ path: `content/posts/${r.slug}.md`, content: r.publishedMarkdown });
      for (const img of r.publishedImages ?? []) {
        files.push({ path: img.repoPath, contentBase64: await readUploadBase64(img.filename) });
      }
    }

    res.json({ files });
  } catch (err) {
    next(err);
  }
});
