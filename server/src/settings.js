import { Router } from 'express';
import { getSetting, setSetting } from './db.js';

export const settingsRouter = Router();

settingsRouter.get('/', async (req, res, next) => {
  try {
    const [owner, repo, branch, authorName] = await Promise.all([
      getSetting('github_owner', 'Z35Tyyyy'),
      getSetting('github_repo', 'blog_blob'),
      getSetting('github_branch', 'main'),
      getSetting('author_name', 'Kanishk Singh'),
    ]);
    res.json({ owner, repo, branch, authorName });
  } catch (err) {
    next(err);
  }
});

settingsRouter.put('/', async (req, res, next) => {
  try {
    const b = req.body ?? {};
    const simple = {
      owner: 'github_owner',
      repo: 'github_repo',
      branch: 'github_branch',
      authorName: 'author_name',
    };
    for (const [field, key] of Object.entries(simple)) {
      if (typeof b[field] === 'string' && b[field].trim()) {
        await setSetting(key, b[field].trim());
      }
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
