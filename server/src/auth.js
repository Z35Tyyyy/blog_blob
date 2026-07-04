import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { db } from './db.js';

const SESSION_COOKIE = 'blogblob_session';
const SESSION_DAYS = 30;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function userCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

function sessionFor(req) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT s.user_id, u.username FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`
    )
    .get(sha256(token), Date.now());
  return row || null;
}

export function requireAuth(req, res, next) {
  const session = sessionFor(req);
  if (!session) return res.status(401).json({ error: 'not authenticated' });
  req.user = session;
  next();
}

function issueSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
    sha256(token),
    userId,
    expires
  );
  // prune expired sessions while we're here
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    // don't let the 30-day bearer token traverse plaintext HTTP in production
    secure: req.secure || process.env.NODE_ENV === 'production',
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

export const authRouter = Router();

authRouter.get('/status', (req, res) => {
  const session = sessionFor(req);
  res.json({
    setupNeeded: userCount() === 0,
    authenticated: !!session,
    username: session?.username ?? null,
  });
});

// First-run: create the single admin account
authRouter.post('/setup', async (req, res) => {
  if (userCount() > 0) return res.status(403).json({ error: 'setup already completed' });
  const { username, password } = req.body ?? {};
  if (typeof username !== 'string' || !/^[\w.-]{3,32}$/.test(username)) {
    return res.status(400).json({ error: 'username: 3-32 chars, letters/digits/._-' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'password must be at least 8 characters' });
  }
  const hash = await bcrypt.hash(password, 10);
  const info = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
  issueSession(req, res, info.lastInsertRowid);
  res.json({ ok: true, username });
});

authRouter.post('/login', async (req, res) => {
  const { username, password } = req.body ?? {};
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username ?? ''));
  const ok = user && (await bcrypt.compare(String(password ?? ''), user.password_hash));
  if (!ok) return res.status(401).json({ error: 'invalid credentials' });
  issueSession(req, res, user.id);
  res.json({ ok: true, username: user.username });
});

authRouter.post('/logout', (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});
