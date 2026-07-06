import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { db } from './db.js';

const SESSION_COOKIE = 'blogblob_session';
const SESSION_DAYS = 30;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function userCount() {
  return db.collection('users').countDocuments();
}

async function sessionFor(req) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  const session = await db.collection('sessions').findOne({
    _id: sha256(token),
    expiresAt: { $gt: new Date() },
  });
  if (!session) return null;
  const user = await db.collection('users').findOne({ _id: session.userId });
  return user ? { user_id: user._id, username: user.username, role: user.role ?? 'admin' } : null;
}

export async function requireAuth(req, res, next) {
  try {
    const session = await sessionFor(req);
    if (!session) return res.status(401).json({ error: 'not authenticated' });
    req.user = session;
    next();
  } catch (err) {
    next(err);
  }
}

/** Demo accounts browse everything but change nothing (created via
    scripts/create-demo-user.mjs — there is no signup endpoint). */
export function demoReadOnly(req, res, next) {
  if (req.user?.role === 'demo' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return res.status(403).json({ error: 'demo account is read-only' });
  }
  next();
}

async function issueSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.collection('sessions').insertOne({
    _id: sha256(token),
    userId,
    expiresAt: new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000),
  });
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

authRouter.get('/status', async (req, res, next) => {
  try {
    const session = await sessionFor(req);
    res.json({
      setupNeeded: (await userCount()) === 0,
      authenticated: !!session,
      username: session?.username ?? null,
      demo: session?.role === 'demo',
    });
  } catch (err) {
    next(err);
  }
});

// First-run: create the single admin account
authRouter.post('/setup', async (req, res, next) => {
  try {
    if ((await userCount()) > 0) return res.status(403).json({ error: 'setup already completed' });
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || !/^[\w.-]{3,32}$/.test(username)) {
      return res.status(400).json({ error: 'username: 3-32 chars, letters/digits/._-' });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'password must be at least 8 characters' });
    }
    const hash = await bcrypt.hash(password, 10);
    const info = await db.collection('users').insertOne({
      username,
      passwordHash: hash,
      createdAt: new Date(),
    });
    await issueSession(req, res, info.insertedId);
    res.json({ ok: true, username });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body ?? {};
    const user = await db.collection('users').findOne({ username: String(username ?? '') });
    const ok = user && (await bcrypt.compare(String(password ?? ''), user.passwordHash));
    if (!ok) return res.status(401).json({ error: 'invalid credentials' });
    await issueSession(req, res, user._id);
    res.json({ ok: true, username: user.username });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/logout', async (req, res, next) => {
  try {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) await db.collection('sessions').deleteOne({ _id: sha256(token) });
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
