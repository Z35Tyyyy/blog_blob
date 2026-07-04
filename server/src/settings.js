import { Router } from 'express';
import { getSetting, setSetting } from './db.js';
import { checkRepoAccess } from './github.js';

export const settingsRouter = Router();

settingsRouter.get('/', (req, res) => {
  res.json({
    owner: getSetting('github_owner', 'Z35Tyyyy'),
    repo: getSetting('github_repo', 'blog_blob'),
    branch: getSetting('github_branch', 'main'),
    authorName: getSetting('author_name', 'Kanishk Singh'),
    hasToken: !!getSetting('github_token'),
  });
});

settingsRouter.put('/', (req, res) => {
  const b = req.body ?? {};
  const simple = {
    owner: 'github_owner',
    repo: 'github_repo',
    branch: 'github_branch',
    authorName: 'author_name',
  };
  for (const [field, key] of Object.entries(simple)) {
    if (typeof b[field] === 'string' && b[field].trim()) {
      setSetting(key, b[field].trim());
    }
  }
  // token: write-only; empty string means "leave unchanged", null means clear
  if (b.githubToken === null) setSetting('github_token', '');
  else if (typeof b.githubToken === 'string' && b.githubToken.trim()) {
    setSetting('github_token', b.githubToken.trim());
  }
  res.json({ ok: true });
});

settingsRouter.post('/test', async (req, res) => {
  const token = getSetting('github_token');
  if (!token) return res.status(400).json({ error: 'no token saved yet' });
  try {
    const info = await checkRepoAccess({
      token,
      owner: getSetting('github_owner', 'Z35Tyyyy'),
      repo: getSetting('github_repo', 'blog_blob'),
    });
    if (!info.canPush) {
      return res.status(403).json({ error: `token can read ${info.fullName} but cannot push to it` });
    }
    res.json({ ok: true, ...info });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});
