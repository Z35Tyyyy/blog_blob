import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import { connect } from './db.js';
import { authRouter, requireAuth } from './auth.js';
import { postsRouter } from './posts.js';
import { uploadsRouter, serveUpload } from './uploads.js';
import { publishRouter } from './publish.js';
import { settingsRouter } from './settings.js';
import { exportRouter } from './export.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// respect X-Forwarded-Proto when TLS terminates at a reverse proxy (req.secure)
app.set('trust proxy', 1);

app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));

// CSRF hardening: mutating requests must come from this app itself, local dev,
// or an explicitly allowed frontend origin (e.g. the Vercel deployment, whose
// rewrites proxy /api here with the browser's Origin header preserved).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean);

app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (!origin) return next(); // same-origin non-CORS request (curl, forms disabled)
  try {
    if (ALLOWED_ORIGINS.includes(origin.replace(/\/$/, ''))) return next();
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
// key-authed (EXPORT_KEY), consumed by the sync-content workflow — not session-authed
app.use('/api/export', exportRouter);

// Draft images (behind auth — drafts are private until published), from GridFS
app.get('/uploads/:filename', requireAuth, serveUpload);

// --- Editor UI (production build, when co-located) ---
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

connect()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`blog_blob server → http://localhost:${PORT}`);
      if (!fs.existsSync(editorDist)) {
        console.log('editor/dist not found — run the editor dev server (npm run dev in editor/)');
      }
    });
  })
  .catch((err) => {
    console.error('failed to connect to MongoDB:', err.message);
    process.exit(1);
  });
