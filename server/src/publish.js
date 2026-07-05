import { Router } from 'express';
import { db, getSetting } from './db.js';
import { buildFrontmatter, localDate, readingTime, rewriteLocalImages } from './markdown.js';
import { commitFiles, listTree } from './github.js';
import { readUploadBase64 } from './uploads.js';
import { oid } from './posts.js';

export const publishRouter = Router();

async function publishConfig() {
  const [token, owner, repo, branch, author] = await Promise.all([
    getSetting('github_token'),
    getSetting('github_owner', 'Z35Tyyyy'),
    getSetting('github_repo', 'blog_blob'),
    getSetting('github_branch', 'main'),
    getSetting('author_name', 'Kanishk Singh'),
  ]);
  return { token, owner, repo, branch, author };
}

/** Public URL a draft-local cover/image will have once published. */
function publicUrl(localUrl, slug, { owner, repo, branch }) {
  if (!localUrl || !localUrl.startsWith('/uploads/')) return localUrl;
  const filename = localUrl.split('/').pop();
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/content/images/${slug}/${filename}`;
}

/**
 * Regenerate content/posts.json from the published-state snapshots — NOT from
 * live rows, so draft edits to a published post never leak into the public
 * index until that post is explicitly republished.
 */
async function buildIndex() {
  const rows = await db
    .collection('posts')
    .find({ status: 'published', publishedJson: { $ne: null } }, { projection: { publishedJson: 1 } })
    .toArray();
  const entries = rows
    .map((r) => JSON.parse(r.publishedJson))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return JSON.stringify(entries, null, 2) + '\n';
}

publishRouter.post('/:id/publish', async (req, res, next) => {
  try {
    const cfg = await publishConfig();
    if (!cfg.token) return res.status(400).json({ error: 'no GitHub token configured (Settings)' });

    const _id = oid(req.params.id);
    const post = _id && (await db.collection('posts').findOne({ _id }));
    if (!post) return res.status(404).json({ error: 'post not found' });
    if (!post.title.trim()) return res.status(400).json({ error: 'give the post a title first' });
    if (!post.markdown.trim()) return res.status(400).json({ error: 'the post has no content' });

    const date = /^\d{4}-\d{2}-\d{2}$/.test(post.date) ? post.date : localDate();

    try {
      // 1. rewrite draft-local image URLs to their published locations
      const { markdown, images } = rewriteLocalImages(post.markdown, post.slug, cfg);

      // any /uploads/ image reference the rewriter couldn't resolve would ship broken
      if (/(\]\(|src=["'])\/uploads\//.test(markdown)) {
        return res.status(400).json({
          error:
            'some image references still point at /uploads/ after rewriting — check for unusual characters in image URLs',
        });
      }

      const files = [];
      for (const img of images) {
        const filename = img.localUrl.split('/').pop();
        files.push({ path: img.repoPath, contentBase64: await readUploadBase64(filename) });
      }

      // cover image, if it's a local upload not already referenced in the body
      if (post.cover.startsWith('/uploads/')) {
        const filename = post.cover.split('/').pop();
        const repoPath = `content/images/${post.slug}/${filename}`;
        if (!files.some((f) => f.path === repoPath)) {
          files.push({ path: repoPath, contentBase64: await readUploadBase64(filename) });
        }
      }

      // 2. frontmatter + body
      const meta = {
        title: post.title,
        date,
        description: post.description,
        tags: post.tags ?? [],
        cover: publicUrl(post.cover, post.slug, cfg),
      };
      files.push({ path: `content/posts/${post.slug}.md`, content: buildFrontmatter(meta) + markdown + '\n' });

      // 3. snapshot the exact index entry being published, then regenerate the index
      const entry = {
        slug: post.slug,
        title: post.title,
        date,
        description: post.description,
        tags: post.tags ?? [],
        cover: publicUrl(post.cover, post.slug, cfg),
        readingTime: readingTime(markdown),
      };
      await db.collection('posts').updateOne(
        { _id },
        {
          $set: {
            status: 'published',
            date,
            publishedAt: new Date(),
            updatedAt: new Date(),
            publishedJson: JSON.stringify(entry),
          },
        }
      );
      files.push({ path: 'content/posts.json', content: await buildIndex() });

      // 4. prune images of this post that are on the branch but no longer referenced
      const existing = await listTree(cfg);
      const newPaths = new Set(files.map((f) => f.path));
      for (const p of existing) {
        if (p.startsWith(`content/images/${post.slug}/`) && !newPaths.has(p)) {
          files.push({ path: p, delete: true });
        }
      }

      // 5. one atomic commit
      const commit = await commitFiles({
        ...cfg,
        message: `publish: ${post.slug}`,
        files,
      });

      res.json({
        ok: true,
        commit,
        slug: post.slug,
        rawUrl: `https://raw.githubusercontent.com/${cfg.owner}/${cfg.repo}/${cfg.branch}/content/posts/${post.slug}.md`,
      });
    } catch (err) {
      // roll the document fully back to its pre-request state if the commit failed
      await db.collection('posts').updateOne(
        { _id },
        {
          $set: {
            status: post.status,
            publishedAt: post.publishedAt,
            date: post.date,
            updatedAt: post.updatedAt,
            publishedJson: post.publishedJson,
          },
        }
      );
      res.status(502).json({ error: err.message });
    }
  } catch (err) {
    next(err);
  }
});

publishRouter.post('/:id/unpublish', async (req, res, next) => {
  try {
    const cfg = await publishConfig();
    if (!cfg.token) return res.status(400).json({ error: 'no GitHub token configured (Settings)' });

    const _id = oid(req.params.id);
    const post = _id && (await db.collection('posts').findOne({ _id }));
    if (!post) return res.status(404).json({ error: 'post not found' });
    if (post.status !== 'published') return res.status(400).json({ error: 'post is not published' });

    try {
      // find everything of this post that actually exists on the branch
      const existing = await listTree(cfg);
      const mine = existing.filter(
        (p) => p === `content/posts/${post.slug}.md` || p.startsWith(`content/images/${post.slug}/`)
      );

      await db.collection('posts').updateOne(
        { _id },
        { $set: { status: 'draft', publishedAt: null, publishedJson: null, updatedAt: new Date() } }
      );

      const files = mine.map((p) => ({ path: p, delete: true }));
      files.push({ path: 'content/posts.json', content: await buildIndex() });

      const commit = await commitFiles({
        ...cfg,
        message: `unpublish: ${post.slug}`,
        files,
      });

      res.json({ ok: true, commit });
    } catch (err) {
      await db.collection('posts').updateOne(
        { _id },
        {
          $set: {
            status: 'published',
            publishedAt: post.publishedAt,
            publishedJson: post.publishedJson,
            updatedAt: post.updatedAt,
          },
        }
      );
      res.status(502).json({ error: err.message });
    }
  } catch (err) {
    next(err);
  }
});
