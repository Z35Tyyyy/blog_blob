import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { db } from './db.js';
import { loginLimiter, setupLimiter } from './security.js';

const SESSION_COOKIE = 'blogblob_session';
// Idle timeout: a session that goes unused for this long expires (Mongo's TTL
// index drops it). Active use slides it forward — see sessionFor().
const SESSION_IDLE_DAYS = 14;
const IDLE_MS = SESSION_IDLE_DAYS * 24 * 60 * 60 * 1000;
const BCRYPT_COST = 12;

// A throwaway bcrypt hash to compare against when the username is unknown, so a
// login for a non-existent user still pays the full bcrypt cost and can't be
// told apart from a wrong password by response timing.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), BCRYPT_COST);

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// When SETUP_TOKEN is configured, first-run setup additionally requires it —
// closing the window where an unauthenticated caller could claim the admin
// account on a fresh deploy before the operator does. Unset → open (fine for
// local dev; set it on any public deployment). Compared in constant time.
function setupTokenOk(provided) {
  const expected = process.env.SETUP_TOKEN;
  if (!expected) return true;
  const a = Buffer.from(String(provided ?? ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function setSessionCookie(req, res, token, expiresAt) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    // don't let the bearer token traverse plaintext HTTP in production
    secure: req.secure || process.env.NODE_ENV === 'production',
    maxAge: expiresAt.getTime() - Date.now(),
    path: '/',
  });
}

/** Users who can actually administer the CMS (absent role = admin). Demo
    accounts must not count towards first-run setup: a database whose only
    users are read-only would otherwise be unrecoverable from the app. */
function adminCount() {
  return db.collection('users').countDocuments({ role: { $ne: 'demo' } });
}

async function sessionFor(req, res) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  const id = sha256(token);
  const session = await db.collection('sessions').findOne({
    _id: id,
    expiresAt: { $gt: new Date() },
  });
  if (!session) return null;
  const user = await db.collection('users').findOne({ _id: session.userId });
  if (!user) return null;
  // Sliding idle expiry: once past the halfway mark, push the deadline out and
  // re-issue the cookie. The halfway gate throttles the write to at most one per
  // ~SESSION_IDLE_DAYS/2 of continuous use.
  if (res && session.expiresAt.getTime() - Date.now() < IDLE_MS / 2) {
    const expiresAt = new Date(Date.now() + IDLE_MS);
    await db.collection('sessions').updateOne({ _id: id }, { $set: { expiresAt } });
    setSessionCookie(req, res, token, expiresAt);
  }
  return { user_id: user._id, username: user.username, role: user.role ?? 'admin' };
}

export async function requireAuth(req, res, next) {
  try {
    const session = await sessionFor(req, res);
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
  const expiresAt = new Date(Date.now() + IDLE_MS);
  await db.collection('sessions').insertOne({
    _id: sha256(token),
    userId,
    expiresAt,
    createdAt: new Date(),
  });
  setSessionCookie(req, res, token, expiresAt);
}

export const authRouter = Router();

authRouter.get('/status', async (req, res, next) => {
  try {
    const session = await sessionFor(req, res);
    res.json({
      setupNeeded: (await adminCount()) === 0,
      setupTokenRequired: !!process.env.SETUP_TOKEN,
      authenticated: !!session,
      username: session?.username ?? null,
      demo: session?.role === 'demo',
    });
  } catch (err) {
    next(err);
  }
});

// First-run: create the single admin account
authRouter.post('/setup', setupLimiter, async (req, res, next) => {
  try {
    if ((await adminCount()) > 0) return res.status(403).json({ error: 'setup already completed' });
    if (!setupTokenOk(req.body?.setupToken)) {
      return res.status(403).json({ error: 'invalid or missing setup token' });
    }
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || !/^[\w.-]{3,32}$/.test(username)) {
      return res.status(400).json({ error: 'username: 3-32 chars, letters/digits/._-' });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'password must be at least 8 characters' });
    }
    const hash = await bcrypt.hash(password, BCRYPT_COST);
    let info;
    try {
      info = await db.collection('users').insertOne({
        username,
        passwordHash: hash,
        createdAt: new Date(),
      });
    } catch (err) {
      // a demo account may already hold this username
      if (err?.code === 11000 || /duplicate/i.test(String(err?.message))) {
        return res.status(400).json({ error: 'username already taken' });
      }
      throw err;
    }
    await issueSession(req, res, info.insertedId);
    res.json({ ok: true, username });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const { username, password } = req.body ?? {};
    const user = await db.collection('users').findOne({ username: String(username ?? '') });
    // compare against a dummy hash for unknown users so timing stays uniform
    const ok = await bcrypt.compare(String(password ?? ''), user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) return res.status(401).json({ error: 'invalid credentials' });
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

// Revoke every session for the current user (e.g. after a suspected token leak),
// then re-issue one for this device so the caller stays signed in here.
authRouter.post('/logout-all', requireAuth, async (req, res, next) => {
  try {
    await db.collection('sessions').deleteMany({ userId: req.user.user_id });
    await issueSession(req, res, req.user.user_id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
