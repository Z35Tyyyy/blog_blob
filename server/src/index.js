import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import { UPLOADS_DIR } from './db.js';
import { authRouter, requireAuth } from './auth.js';
import { postsRouter } from './posts.js';
import { uploadsRouter } from './uploads.js';
import { publishRouter } from './publish.js';
import { settingsRouter } from './settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// respect X-Forwarded-Proto when TLS terminates at a reverse proxy (req.secure)
app.set('trust proxy', 1);

app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));

// CSRF hardening: mutating requests must come from this app (or local dev).
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (!origin) return next(); // same-origin non-CORS request (curl, forms disabled)
  try {
    const host = new URL(origin).host;
    const sameHost = host === req.headers.host;
    const localDev = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
    if (sameHost || localDev) return next();
  } catch { /* fall through */ }
  res.status(403).json({ error: 'cross-origin request rejected' });
});

// --- API ---
app.use('/api', authRouter);
app.use('/api/posts', requireAuth, postsRouter);
app.use('/api/posts', requireAuth, publishRouter); // /:id/publish, /:id/unpublish
app.use('/api/uploads', requireAuth, uploadsRouter);
app.use('/api/settings', requireAuth, settingsRouter);

// Draft images (behind auth — drafts are private until published)
app.use('/uploads', requireAuth, express.static(UPLOADS_DIR, { fallthrough: false }));

// --- Editor UI (production build) ---
const editorDist = path.join(__dirname, '..', '..', 'editor', 'dist');
if (fs.existsSync(editorDist)) {
  app.use(express.static(editorDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) return next();
    res.sendFile(path.join(editorDist, 'index.html'));
  });
}

// --- Errors ---
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: status < 500 ? err.message : 'internal error' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`blog_blob server → http://localhost:${PORT}`);
  if (!fs.existsSync(editorDist)) {
    console.log('editor/dist not found — run the editor dev server (npm run dev in editor/)');
  }
});
