// End-to-end API smoke test against an in-memory MongoDB.
// Boots the real server process — no mocks. Run with: npm test

import { spawn } from 'node:child_process';
import { MongoMemoryServer } from 'mongodb-memory-server';

const PORT = 4111;
const BASE = `http://127.0.0.1:${PORT}`;
const ALLOWED_ORIGIN = 'https://allowed.example';

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

let cookie = '';
async function call(path, { method = 'GET', json, form, origin, auth = true } = {}) {
  const headers = {};
  if (auth && cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  if (json) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: json ? JSON.stringify(json) : form,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  let body = null;
  try {
    body = await res.json();
  } catch { /* non-json */ }
  return { status: res.status, body, res };
}

const mongod = await MongoMemoryServer.create();
const child = spawn(process.execPath, ['src/index.js'], {
  env: {
    ...process.env,
    MONGODB_URI: mongod.getUri(),
    MONGODB_DB: 'blog_blob_test',
    PORT: String(PORT),
    ALLOWED_ORIGINS: ALLOWED_ORIGIN,
    NODE_ENV: 'test',
  },
  stdio: ['ignore', 'pipe', 'inherit'],
});
child.stdout.on('data', () => {});

// wait for the server to accept requests
let up = false;
for (let i = 0; i < 50 && !up; i++) {
  try {
    const r = await fetch(`${BASE}/api/status`);
    up = r.ok;
  } catch {
    await new Promise((r) => setTimeout(r, 200));
  }
}

try {
  if (!up) throw new Error('server did not start');
  console.log('server up — running checks\n');

  // --- auth ---
  let r = await call('/api/status');
  check('fresh status: setup needed', r.body?.setupNeeded === true);

  r = await call('/api/posts');
  check('posts without auth → 401', r.status === 401);

  r = await call('/api/setup', { method: 'POST', json: { username: 'admin', password: 'longenough1' } });
  check('setup creates admin + session', r.status === 200 && !!cookie);

  r = await call('/api/setup', { method: 'POST', json: { username: 'evil', password: 'hackhackhack' }, auth: false });
  check('duplicate setup blocked', r.status === 403);

  r = await call('/api/status');
  check('status authed', r.body?.authenticated === true && r.body?.username === 'admin');

  // --- CSRF ---
  r = await call('/api/posts', { method: 'POST', json: { title: 'x' }, origin: 'https://evil.example' });
  check('cross-origin POST rejected', r.status === 403);

  r = await call('/api/posts', { method: 'POST', json: { title: 'Allowed Origin Post' }, origin: ALLOWED_ORIGIN });
  check('ALLOWED_ORIGINS origin accepted', r.status === 201, `got ${r.status}`);
  const allowedId = r.body?.id;

  // --- posts CRUD ---
  r = await call('/api/posts', { method: 'POST', json: { title: 'My Test Post!' } });
  check('create post', r.status === 201 && r.body?.slug === 'my-test-post');
  check('post id is a string oid', typeof r.body?.id === 'string' && r.body.id.length === 24);
  const id = r.body.id;

  r = await call(`/api/posts/${id}`, {
    method: 'PUT',
    json: { markdown: '## hi\n\n![x](/uploads/nope.png)', tags: ['CTF', ' Meta '], description: 'd' },
  });
  check('update normalizes tags', JSON.stringify(r.body?.tags) === '["ctf","meta"]');

  r = await call(`/api/posts/${id}`, { method: 'PUT', json: { date: 'tomorrow' } });
  check('bad date rejected', r.status === 400);

  r = await call(`/api/posts/${id}`, { method: 'PUT', json: { slug: 'Bad Slug!!' } });
  check('bad slug rejected', r.status === 400);

  r = await call('/api/posts/not-an-oid');
  check('invalid oid → 404', r.status === 404);

  // --- uploads (GridFS) ---
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  let form = new FormData();
  form.append('image', new Blob([png], { type: 'image/png' }), 'Test IMG.png');
  r = await call('/api/uploads', { method: 'POST', form });
  check('png upload → GridFS', r.status === 201 && r.body?.url?.startsWith('/uploads/test-img-'));
  const uploadUrl = r.body.url;

  r = await call(uploadUrl);
  check('uploaded image serves (authed)', r.status === 200 && r.res.headers.get('content-type') === 'image/png');

  {
    const anon = await fetch(BASE + uploadUrl);
    check('uploaded image blocked anon', anon.status === 401);
  }

  form = new FormData();
  form.append('image', new Blob(['not an image'], { type: 'text/plain' }), 'evil.txt');
  r = await call('/api/uploads', { method: 'POST', form });
  check('non-image upload → 400', r.status === 400);

  // --- publish guard ---
  r = await call(`/api/posts/${id}/publish`, { method: 'POST' });
  check('publish without token → clean 400', r.status === 400 && /token/.test(r.body?.error ?? ''));

  // --- settings ---
  r = await call('/api/settings');
  check('settings defaults', r.body?.owner === 'Z35Tyyyy' && r.body?.hasToken === false);

  // --- delete + logout ---
  r = await call(`/api/posts/${id}`, { method: 'DELETE' });
  check('delete draft', r.body?.ok === true);
  r = await call(`/api/posts/${allowedId}`, { method: 'DELETE' });
  check('delete second draft', r.body?.ok === true);

  await call('/api/logout', { method: 'POST' });
  r = await call('/api/posts');
  check('after logout → 401', r.status === 401);
} catch (err) {
  failed++;
  console.error('fatal:', err.message);
} finally {
  child.kill();
  await mongod.stop();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
