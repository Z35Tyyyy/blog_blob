import { Router } from 'express';
import { db, getSetting } from './db.js';
import { buildFrontmatter, localDate, readingTime, rewriteLocalImages } from './markdown.js';
import { oid } from './posts.js';

export const publishRouter = Router();

async function publishConfig() {
  const [owner, repo, branch, author] = await Promise.all([
    getSetting('github_owner', 'Z35Tyyyy'),
    getSetting('github_repo', 'blog_blob'),
    getSetting('github_branch', 'main'),
    getSetting('author_name', 'Kanishk Singh'),
  ]);
  return { owner, repo, branch, author };
}

/** Public URL a draft-local cover/image will have once published. */
function publicUrl(localUrl, slug, { owner, repo, branch }) {
  if (!localUrl || !localUrl.startsWith('/uploads/')) return localUrl;
  const filename = localUrl.split('/').pop();
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/content/images/${slug}/${filename}`;
}

/**
 * Publishing is a pure database operation: it snapshots the exact files this
 * post contributes to content/ (final markdown incl. frontmatter, plus the
 * list of images to copy out of GridFS). The sync-content GitHub Actions
 * workflow reads those snapshots via /api/export/content and reconciles the
 * repo — no GitHub credentials ever touch this server.
 */
publishRouter.post('/:id/publish', async (req, res, next) => {
  try {
    const cfg = await publishConfig();

    const _id = oid(req.params.id);
    const post = _id && (await db.collection('posts').findOne({ _id }));
    if (!post) return res.status(404).json({ error: 'post not found' });
    if (!post.title.trim()) return res.status(400).json({ error: 'give the post a title first' });
    if (!post.markdown.trim()) return res.status(400).json({ error: 'the post has no content' });

    const date = /^\d{4}-\d{2}-\d{2}$/.test(post.date) ? post.date : localDate();

    // 1. rewrite draft-local image URLs to their published locations
    const { markdown, images } = rewriteLocalImages(post.markdown, post.slug, cfg);

    // any /uploads/ image reference the rewriter couldn't resolve would ship broken
    if (/(\]\(|src=["'])\/uploads\//.test(markdown)) {
      return res.status(400).json({
        error:
          'some image references still point at /uploads/ after rewriting — check for unusual characters in image URLs',
      });
    }

    const publishedImages = images.map((img) => ({
      repoPath: img.repoPath,
      filename: img.localUrl.split('/').pop(),
    }));

    // cover image, if it's a local upload not already referenced in the body
    if (post.cover.startsWith('/uploads/')) {
      const filename = post.cover.split('/').pop();
      const repoPath = `content/images/${post.slug}/${filename}`;
      if (!publishedImages.some((f) => f.repoPath === repoPath)) {
        publishedImages.push({ repoPath, filename });
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

    // 3. snapshot the index entry and the exact file contents being published
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
          publishedMarkdown: buildFrontmatter(meta) + markdown + '\n',
          publishedImages,
        },
      }
    );

    res.json({ ok: true, queued: true, slug: post.slug });
  } catch (err) {
    next(err);
  }
});

publishRouter.post('/:id/unpublish', async (req, res, next) => {
  try {
    const _id = oid(req.params.id);
    const post = _id && (await db.collection('posts').findOne({ _id }));
    if (!post) return res.status(404).json({ error: 'post not found' });
    if (post.status !== 'published') return res.status(400).json({ error: 'post is not published' });

    // dropping the snapshots removes the post from the export manifest; the
    // next content sync deletes its files from the repo
    await db.collection('posts').updateOne(
      { _id },
      {
        $set: {
          status: 'draft',
          publishedAt: null,
          publishedJson: null,
          publishedMarkdown: null,
          publishedImages: null,
          updatedAt: new Date(),
        },
      }
    );

    res.json({ ok: true, queued: true });
  } catch (err) {
    next(err);
  }
});
