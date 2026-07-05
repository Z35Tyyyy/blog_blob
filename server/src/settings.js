import { Router } from 'express';
import { getSetting, setSetting } from './db.js';
import { checkRepoAccess } from './github.js';

export const settingsRouter = Router();

settingsRouter.get('/', async (req, res, next) => {
  try {
    const [owner, repo, branch, authorName, token] = await Promise.all([
      getSetting('github_owner', 'Z35Tyyyy'),
      getSetting('github_repo', 'blog_blob'),
      getSetting('github_branch', 'main'),
      getSetting('author_name', 'Kanishk Singh'),
      getSetting('github_token'),
    ]);
    res.json({ owner, repo, branch, authorName, hasToken: !!token });
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
    // token: write-only; empty string means "leave unchanged", null means clear
    if (b.githubToken === null) await setSetting('github_token', '');
    else if (typeof b.githubToken === 'string' && b.githubToken.trim()) {
      await setSetting('github_token', b.githubToken.trim());
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

settingsRouter.post('/test', async (req, res, next) => {
  try {
    const token = await getSetting('github_token');
    if (!token) return res.status(400).json({ error: 'no token saved yet' });
    try {
      const info = await checkRepoAccess({
        token,
        owner: await getSetting('github_owner', 'Z35Tyyyy'),
        repo: await getSetting('github_repo', 'blog_blob'),
      });
      if (!info.canPush) {
        return res.status(403).json({ error: `token can read ${info.fullName} but cannot push to it` });
      }
      res.json({ ok: true, ...info });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  } catch (err) {
    next(err);
  }
});
