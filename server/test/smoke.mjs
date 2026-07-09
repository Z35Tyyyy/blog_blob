// End-to-end API smoke test against an in-memory MongoDB.
// Boots the real server process — no mocks. Run with: npm test

import { spawn, spawnSync } from 'node:child_process';
import { MongoClient } from 'mongodb';
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

// SMOKE_MONGODB_URI points the suite at an existing MongoDB-compatible
// server, for environments where the memory-server binary can't download.
const mongod = process.env.SMOKE_MONGODB_URI ? null : await MongoMemoryServer.create();
const uri = process.env.SMOKE_MONGODB_URI || mongod.getUri();
const child = spawn(process.execPath, ['src/index.js'], {
  env: {
    ...process.env,
    MONGODB_URI: uri,
    MONGODB_DB: 'blog_blob_test',
    PORT: String(PORT),
    ALLOWED_ORIGINS: ALLOWED_ORIGIN,
    EXPORT_KEY: 'test-export-key',
    LOGIN_RATE_LIMIT_MAX: '5', // keep the 429 path deterministic below
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

  // --- revision checkpoints ---
  r = await call(`/api/posts/${id}/revisions`);
  check('no checkpoints before a body change', Array.isArray(r.body) && r.body.length === 0);

  await call(`/api/posts/${id}`, { method: 'PUT', json: { markdown: 'second version of the body' } });
  r = await call(`/api/posts/${id}/revisions`);
  check('body change checkpoints the previous version', r.body?.length === 1 && r.body[0].words === 3);
  const revId = r.body?.[0]?.id;

  r = await call(`/api/posts/${id}/revisions/${revId}`);
  check('checkpoint holds the pre-edit markdown', r.body?.markdown === '## hi\n\n![x](/uploads/nope.png)');

  await call(`/api/posts/${id}`, { method: 'PUT', json: { markdown: 'third version' } });
  r = await call(`/api/posts/${id}/revisions`);
  check('rapid saves collapse into one checkpoint', r.body?.length === 1);

  r = await call(`/api/posts/${id}/revisions/${'0'.repeat(24)}`);
  check('unknown revision → 404', r.status === 404);

  // --- WAF-safe transport: base64-wrapped JSON write bodies ---
  {
    const nasty =
      "payload zoo: ' OR 1=1 -- <script>alert(1)</script> ../../etc/passwd {{7*7}} $(cat /etc/shadow)";
    const wrapped = Buffer.from(JSON.stringify({ markdown: nasty }), 'utf8').toString('base64');
    r = await call(`/api/posts/${id}`, { method: 'PUT', json: { b64: wrapped } });
    check('b64-wrapped update accepted', r.status === 200, `got ${r.status}`);
    r = await call(`/api/posts/${id}`);
    check('b64 body roundtrips exactly', r.body?.markdown === nasty);

    r = await call(`/api/posts/${id}`, { method: 'PUT', json: { b64: '%%%not-base64%%%' } });
    check('unparseable b64 body → 400', r.status === 400);

    const nonObject = Buffer.from('"just a string"', 'utf8').toString('base64');
    r = await call(`/api/posts/${id}`, { method: 'PUT', json: { b64: nonObject } });
    check('non-object b64 body → 400', r.status === 400);
  }

  // --- optimistic concurrency (edit conflict) ---
  {
    const cur = await call(`/api/posts/${id}`);
    const base = cur.body.updated_at;
    r = await call(`/api/posts/${id}`, { method: 'PUT', json: { markdown: 'conflict v1', baseUpdatedAt: base } });
    check('save with the current base version accepted', r.status === 200);
    // the same base is now stale (updated_at moved), so replaying it is rejected
    r = await call(`/api/posts/${id}`, { method: 'PUT', json: { markdown: 'conflict v2', baseUpdatedAt: base } });
    check('stale base version rejected with 409', r.status === 409);
    // no base version → check skipped (back-compat)
    r = await call(`/api/posts/${id}`, { method: 'PUT', json: { markdown: 'no base check' } });
    check('save without a base version still works', r.status === 200);
  }

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

  // bytes must actually be an image, not just a claimed image/* content-type
  form = new FormData();
  form.append('image', new Blob(['<html>not really a png</html>'], { type: 'image/png' }), 'fake.png');
  r = await call('/api/uploads', { method: 'POST', form });
  check('image/png with non-image bytes → 400', r.status === 400);

  // --- publish (queued, snapshot-based) + export ---
  r = await call(`/api/posts/${id}`, {
    method: 'PUT',
    json: { markdown: `words here\n\n![pic](${uploadUrl})` },
  });
  r = await call(`/api/posts/${id}/publish`, { method: 'POST' });
  check('publish queues without any token', r.status === 200 && r.body?.queued === true);

  r = await call(`/api/posts/${id}`);
  check('post flipped to published', r.body?.status === 'published');

  {
    const anon = await fetch(`${BASE}/api/export/content`);
    check('export without key → 401', anon.status === 401);

    const wrong = await fetch(`${BASE}/api/export/content`, {
      headers: { authorization: 'Bearer wrong-key' },
    });
    check('export with wrong key → 401', wrong.status === 401);

    const good = await fetch(`${BASE}/api/export/content`, {
      headers: { authorization: 'Bearer test-export-key' },
    });
    const manifest = good.status === 200 ? await good.json() : null;
    const paths = manifest?.files?.map((f) => f.path) ?? [];
    const imgFilename = uploadUrl.split('/').pop();
    check(
      'export manifest: index + post + image',
      paths.includes('content/posts.json') &&
        paths.includes('content/posts/my-test-post.md') &&
        paths.includes(`content/images/my-test-post/${imgFilename}`)
    );
    const md = manifest?.files?.find((f) => f.path === 'content/posts/my-test-post.md')?.content ?? '';
    check(
      'published markdown rewrote image to raw URL',
      md.startsWith('---\n') && md.includes(`raw.githubusercontent.com`) && !md.includes('](/uploads/')
    );
    const img = manifest?.files?.find((f) => f.path.startsWith('content/images/'));
    check('image ships as base64', typeof img?.contentBase64 === 'string' && img.contentBase64.length > 0);
    const index = JSON.parse(manifest?.files?.find((f) => f.path === 'content/posts.json')?.content ?? '[]');
    check('index entry snapshotted', index.length === 1 && index[0].slug === 'my-test-post');
  }

  r = await call(`/api/posts/${id}/unpublish`, { method: 'POST' });
  check('unpublish queues', r.status === 200 && r.body?.ok === true);

  {
    const good = await fetch(`${BASE}/api/export/content`, {
      headers: { authorization: 'Bearer test-export-key' },
    });
    const manifest = await good.json();
    check(
      'unpublished post leaves the manifest',
      manifest.files.length === 1 && manifest.files[0].path === 'content/posts.json'
    );
  }

  // --- settings ---
  r = await call('/api/settings');
  check(
    'settings defaults',
    r.body?.owner === 'Z35Tyyyy' && r.body?.authorName === 'Kanishk Singh' && r.body?.siteUrl === ''
  );

  const exportManifest = async () => {
    const good = await fetch(`${BASE}/api/export/content`, {
      headers: { authorization: 'Bearer test-export-key' },
    });
    return good.json();
  };
  const hasPath = (m, p) => m.files.some((f) => f.path === p);

  // --- scheduled publishing: a future publishAt withholds from the manifest ---
  {
    r = await call(`/api/posts/${id}/publish`, { method: 'POST', json: { publishAt: '2999-01-01T00:00:00Z' } });
    check('scheduled publish accepted', r.status === 200);
    r = await call(`/api/posts/${id}`);
    check('scheduled post carries publish_at', typeof r.body?.publish_at === 'string');
    let m = await exportManifest();
    check('scheduled post withheld from manifest', !hasPath(m, 'content/posts/my-test-post.md'));
    // immediate re-publish (no future publishAt) → it appears
    r = await call(`/api/posts/${id}/publish`, { method: 'POST', json: { publishAt: null } });
    check('immediate re-publish accepted', r.status === 200);
    m = await exportManifest();
    check('immediate post appears in manifest', hasPath(m, 'content/posts/my-test-post.md'));
  }

  // --- RSS feed + sitemap (needs a site URL; id is published from above) ---
  {
    await call('/api/settings', { method: 'PUT', json: { siteUrl: 'https://blog.example' } });
    const m = await exportManifest();
    check('manifest gains feed.xml + sitemap.xml', hasPath(m, 'content/feed.xml') && hasPath(m, 'content/sitemap.xml'));
    const feed = m.files.find((f) => f.path === 'content/feed.xml')?.content ?? '';
    check(
      'feed.xml is RSS listing the post',
      feed.includes('<rss') && feed.includes('my-test-post') && feed.includes('blog.example')
    );
    const sm = m.files.find((f) => f.path === 'content/sitemap.xml')?.content ?? '';
    check('sitemap.xml lists the post', sm.includes('<urlset') && sm.includes('my-test-post'));
  }

  // back to a draft so the delete-draft step below still applies
  await call(`/api/posts/${id}/unpublish`, { method: 'POST' });

  // --- delete + logout ---
  r = await call(`/api/posts/${id}`, { method: 'DELETE' });
  check('delete draft', r.body?.ok === true);
  r = await call(`/api/posts/${id}/revisions`);
  check('revisions of a deleted post → 404', r.status === 404);
  r = await call(`/api/posts/${allowedId}`, { method: 'DELETE' });
  check('delete second draft', r.body?.ok === true);

  // --- change password ---
  {
    r = await call('/api/change-password', { method: 'POST', json: { currentPassword: 'nope', newPassword: 'brandnewpass1' } });
    check('change-password rejects a wrong current password', r.status === 403);
    r = await call('/api/change-password', { method: 'POST', json: { currentPassword: 'longenough1', newPassword: 'short' } });
    check('change-password rejects a weak new password', r.status === 400);
    const beforeChange = cookie; // admin session prior to the change
    r = await call('/api/change-password', { method: 'POST', json: { currentPassword: 'longenough1', newPassword: 'brandnewpass1' } });
    check('change-password succeeds', r.status === 200 && r.body?.ok === true);
    const oldLogin = await fetch(`${BASE}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'longenough1' }),
    });
    check('old password no longer logs in', oldLogin.status === 401);
    const stale = await fetch(`${BASE}/api/posts`, { headers: { cookie: beforeChange } });
    check('other sessions revoked on password change', stale.status === 401);
    r = await call('/api/status');
    check('current device kept after password change', r.body?.authenticated === true);
  }

  // --- session revocation (log out everywhere) ---
  {
    const preRevoke = cookie; // current admin session token
    r = await call('/api/logout-all', { method: 'POST' });
    check('logout-all succeeds', r.status === 200 && r.body?.ok === true);
    r = await call('/api/status'); // helper now holds the freshly re-issued cookie
    check('current device stays signed in after logout-all', r.body?.authenticated === true);
    const stale = await fetch(`${BASE}/api/posts`, { headers: { cookie: preRevoke } });
    check('pre-revoke session token is invalidated', stale.status === 401);
  }

  await call('/api/logout', { method: 'POST' });
  r = await call('/api/posts');
  check('after logout → 401', r.status === 401);

  // --- demo account (read-only) ---
  {
    const made = spawnSync(
      process.execPath,
      ['scripts/create-demo-user.mjs', 'demo', 'browse-only'],
      { env: { ...process.env, MONGODB_URI: uri, MONGODB_DB: 'blog_blob_test' } }
    );
    check('demo user script succeeds', made.status === 0, String(made.stderr));
  }

  cookie = '';
  r = await call('/api/login', { method: 'POST', json: { username: 'demo', password: 'browse-only' } });
  check('demo login works', r.status === 200 && !!cookie);

  r = await call('/api/status');
  check('status flags demo session', r.body?.demo === true && r.body?.username === 'demo');

  r = await call('/api/posts');
  check('demo can browse posts', r.status === 200 && Array.isArray(r.body));

  r = await call('/api/posts', { method: 'POST', json: { title: 'demo vandalism' } });
  check('demo cannot create posts', r.status === 403 && /read-only/.test(r.body?.error ?? ''));

  r = await call(`/api/posts/${'0'.repeat(24)}/publish`, { method: 'POST' });
  check('demo cannot publish', r.status === 403);

  r = await call('/api/settings', { method: 'PUT', json: { authorName: 'hax' } });
  check('demo cannot change settings', r.status === 403);

  r = await call('/api/change-password', { method: 'POST', json: { currentPassword: 'browse-only', newPassword: 'hacked-pass1' } });
  check('demo cannot change password', r.status === 403);

  {
    const form2 = new FormData();
    form2.append('image', new Blob([png], { type: 'image/png' }), 'demo.png');
    r = await call('/api/uploads', { method: 'POST', form: form2 });
    check('demo cannot upload', r.status === 403);
  }

  r = await call('/api/settings');
  check('demo can read settings', r.status === 200 && r.body?.owner === 'Z35Tyyyy');

  // --- role recovery: a mis-roled admin must not brick the CMS ---
  {
    const direct = new MongoClient(uri);
    await direct.connect();
    const users = direct.db('blog_blob_test').collection('users');

    await users.updateOne({ username: 'admin' }, { $set: { role: 'demo' } });
    r = await call('/api/status', { auth: false });
    check('demo-only database → setup opens again', r.body?.setupNeeded === true);

    r = await call('/api/setup', {
      method: 'POST',
      json: { username: 'demo', password: 'password123' },
      auth: false,
    });
    check('setup with a taken username → 400', r.status === 400);

    cookie = '';
    r = await call('/api/setup', { method: 'POST', json: { username: 'admin2', password: 'longenough2' } });
    check('setup creates a fresh admin for recovery', r.status === 200 && !!cookie);

    r = await call('/api/posts', { method: 'POST', json: { title: 'Recovery Post' } });
    check('recovered admin can write again', r.status === 201);
    await call(`/api/posts/${r.body?.id}`, { method: 'DELETE' });

    const promoted = spawnSync(
      process.execPath,
      ['scripts/promote-admin.mjs', 'admin'],
      { env: { ...process.env, MONGODB_URI: uri, MONGODB_DB: 'blog_blob_test' } }
    );
    check('promote-admin restores the original admin', promoted.status === 0, String(promoted.stderr));
    const restored = await users.findOne({ username: 'admin' });
    check('restored admin has no demo role', (restored?.role ?? 'admin') !== 'demo');
    await direct.close();
  }

  {
    const made = spawnSync(
      process.execPath,
      ['scripts/create-demo-user.mjs'],
      { env: { ...process.env, MONGODB_URI: uri, MONGODB_DB: 'blog_blob_test_fresh' } }
    );
    check('demo script refuses to run before first-run setup', made.status === 1);
  }

  // --- setup-token gating (fresh server + DB with SETUP_TOKEN set) ---
  {
    const P2 = 4112;
    const B2 = `http://127.0.0.1:${P2}`;
    const TOKEN = 's3cr3t-setup-token';
    const child2 = spawn(process.execPath, ['src/index.js'], {
      env: {
        ...process.env,
        MONGODB_URI: uri,
        MONGODB_DB: 'blog_blob_setuptoken',
        PORT: String(P2),
        ALLOWED_ORIGINS: ALLOWED_ORIGIN,
        EXPORT_KEY: 'test-export-key',
        SETUP_TOKEN: TOKEN,
        NODE_ENV: 'test',
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    child2.stdout.on('data', () => {});
    const post = (body) =>
      fetch(`${B2}/api/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    try {
      let up2 = false;
      for (let i = 0; i < 50 && !up2; i++) {
        try {
          const rr = await fetch(`${B2}/api/status`);
          up2 = rr.ok;
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      check('setup-token server starts', up2);

      const st = await (await fetch(`${B2}/api/status`)).json();
      check('status advertises setupTokenRequired', st.setupNeeded === true && st.setupTokenRequired === true);

      let rr = await post({ username: 'admin', password: 'longenough1' });
      check('setup without token → 403', rr.status === 403);
      rr = await post({ username: 'admin', password: 'longenough1', setupToken: 'wrong' });
      check('setup with wrong token → 403', rr.status === 403);
      rr = await post({ username: 'admin', password: 'longenough1', setupToken: TOKEN });
      check('setup with correct token → 200', rr.status === 200);
    } finally {
      child2.kill();
    }
  }

  // --- login rate limiting (LOGIN_RATE_LIMIT_MAX=5 for this suite) ---
  // run last: it deliberately trips the limiter for this IP.
  {
    const statuses = [];
    for (let i = 0; i < 7; i++) {
      const res = await fetch(`${BASE}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'definitely-wrong' }),
      });
      statuses.push(res.status);
    }
    check('bad logins get throttled with 429', statuses.includes(429), `statuses: ${statuses.join(',')}`);
    check('limiter allows some attempts before blocking', statuses.indexOf(429) >= 1, `statuses: ${statuses.join(',')}`);
  }
} catch (err) {
  failed++;
  console.error('fatal:', err.message);
} finally {
  child.kill();
  await mongod?.stop();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
