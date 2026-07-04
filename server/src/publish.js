import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { db, getSetting, UPLOADS_DIR } from './db.js';
import { buildFrontmatter, localDate, readingTime, rewriteLocalImages } from './markdown.js';
import { commitFiles, listTree } from './github.js';

export const publishRouter = Router();

function publishConfig() {
  return {
    token: getSetting('github_token'),
    owner: getSetting('github_owner', 'Z35Tyyyy'),
    repo: getSetting('github_repo', 'blog_blob'),
    branch: getSetting('github_branch', 'main'),
    author: getSetting('author_name', 'Kanishk Singh'),
  };
}

/** Public URL a draft-local cover/image will have once published. */
function publicUrl(localUrl, slug, { owner, repo, branch }) {
  if (!localUrl || !localUrl.startsWith('/uploads/')) return localUrl;
  const filename = decodeURIComponent(localUrl.split('/').pop());
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/content/images/${slug}/${filename}`;
}

/**
 * Regenerate content/posts.json from the published-state snapshots — NOT from
 * live rows, so draft edits to a published post never leak into the public
 * index until that post is explicitly republished.
 */
function buildIndex() {
  const rows = db
    .prepare("SELECT published_json FROM posts WHERE status = 'published' AND published_json IS NOT NULL")
    .all();
  const entries = rows
    .map((r) => JSON.parse(r.published_json))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return JSON.stringify(entries, null, 2) + '\n';
}

function localImageFile(localUrl) {
  const filename = decodeURIComponent(localUrl.split('/').pop());
  const filePath = path.join(UPLOADS_DIR, filename);
  // guard against traversal — must resolve inside the uploads dir
  if (!filePath.startsWith(UPLOADS_DIR)) throw new Error(`invalid upload path: ${localUrl}`);
  if (!fs.existsSync(filePath)) throw new Error(`uploaded image missing on disk: ${filename}`);
  return fs.readFileSync(filePath).toString('base64');
}

publishRouter.post('/:id/publish', async (req, res) => {
  const cfg = publishConfig();
  if (!cfg.token) return res.status(400).json({ error: 'no GitHub token configured (Settings)' });

  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
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
      files.push({ path: img.repoPath, contentBase64: localImageFile(img.localUrl) });
    }

    // cover image, if it's a local upload not already referenced in the body
    if (post.cover.startsWith('/uploads/')) {
      const filename = post.cover.split('/').pop();
      const repoPath = `content/images/${post.slug}/${filename}`;
      if (!files.some((f) => f.path === repoPath)) {
        files.push({ path: repoPath, contentBase64: localImageFile(post.cover) });
      }
    }

    // 2. frontmatter + body
    const meta = {
      title: post.title,
      date,
      description: post.description,
      tags: JSON.parse(post.tags || '[]'),
      cover: publicUrl(post.cover, post.slug, cfg),
    };
    files.push({ path: `content/posts/${post.slug}.md`, content: buildFrontmatter(meta) + markdown + '\n' });

    // 3. snapshot the exact index entry being published, then regenerate the index
    const entry = {
      slug: post.slug,
      title: post.title,
      date,
      description: post.description,
      tags: JSON.parse(post.tags || '[]'),
      cover: publicUrl(post.cover, post.slug, cfg),
      readingTime: readingTime(markdown),
    };
    db.prepare(
      "UPDATE posts SET status='published', date=?, published_at=datetime('now'), updated_at=datetime('now'), published_json=? WHERE id=?"
    ).run(date, JSON.stringify(entry), post.id);
    files.push({ path: 'content/posts.json', content: buildIndex() });

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
    // roll the row fully back to its pre-request state if the commit failed
    db.prepare(
      'UPDATE posts SET status=?, published_at=?, date=?, updated_at=?, published_json=? WHERE id=?'
    ).run(post.status, post.published_at, post.date, post.updated_at, post.published_json, post.id);
    res.status(502).json({ error: err.message });
  }
});

publishRouter.post('/:id/unpublish', async (req, res) => {
  const cfg = publishConfig();
  if (!cfg.token) return res.status(400).json({ error: 'no GitHub token configured (Settings)' });

  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'post not found' });
  if (post.status !== 'published') return res.status(400).json({ error: 'post is not published' });

  try {
    // find everything of this post that actually exists on the branch
    const existing = await listTree(cfg);
    const mine = existing.filter(
      (p) => p === `content/posts/${post.slug}.md` || p.startsWith(`content/images/${post.slug}/`)
    );

    db.prepare(
      "UPDATE posts SET status='draft', published_at=NULL, published_json=NULL, updated_at=datetime('now') WHERE id=?"
    ).run(post.id);

    const files = mine.map((p) => ({ path: p, delete: true }));
    files.push({ path: 'content/posts.json', content: buildIndex() });

    const commit = await commitFiles({
      ...cfg,
      message: `unpublish: ${post.slug}`,
      files,
    });

    res.json({ ok: true, commit });
  } catch (err) {
    db.prepare(
      "UPDATE posts SET status='published', published_at=?, published_json=?, updated_at=? WHERE id=?"
    ).run(post.published_at, post.published_json, post.updated_at, post.id);
    res.status(502).json({ error: err.message });
  }
});
