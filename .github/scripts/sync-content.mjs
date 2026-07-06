// Reconciles the repo's content/ tree with the CMS export manifest.
// Runs inside the sync-content workflow (node 20+, no dependencies).
//
// env: API_URL     base URL of the CMS API (Render service)
//      EXPORT_KEY  shared key for GET /api/export/content
//
// Exit modes:
//   - API asleep/unreachable → prints a notice, sets skipped=true, exit 0
//     (expected on the free tier; the next scheduled run retries)
//   - export rejects or malformed manifest → exit 1 (loud config/data error)

import { appendFileSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const API = (process.env.API_URL || '').replace(/\/$/, '');
const KEY = process.env.EXPORT_KEY || '';
if (!API || !KEY) {
  console.error('API_URL and EXPORT_KEY are required');
  process.exit(1);
}

const skip = (reason) => {
  console.log(`skipping sync: ${reason}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'skipped=true\n');
  process.exit(0);
};

// --- wake the free-tier server (cold start can take ~60-90s) ---
const WAKE_DEADLINE = Date.now() + 150_000;
let awake = false;
while (Date.now() < WAKE_DEADLINE) {
  try {
    const r = await fetch(`${API}/api/status`, { signal: AbortSignal.timeout(10_000) });
    if (r.ok) {
      awake = true;
      break;
    }
  } catch {
    /* still asleep */
  }
  await new Promise((r) => setTimeout(r, 10_000));
}
if (!awake) skip(`API at ${API} did not respond within the wake window`);

// --- fetch the manifest ---
const res = await fetch(`${API}/api/export/content`, {
  headers: { authorization: `Bearer ${KEY}` },
  signal: AbortSignal.timeout(60_000),
});
if (!res.ok) {
  const body = await res.text().catch(() => '');
  console.error(`export failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  process.exit(1);
}
const manifest = await res.json();
if (!Array.isArray(manifest.files) || !manifest.files.some((f) => f.path === 'content/posts.json')) {
  console.error('malformed manifest: missing files[] or content/posts.json');
  process.exit(1);
}
for (const f of manifest.files) {
  if (!/^content\/[A-Za-z0-9._/-]+$/.test(f.path) || f.path.includes('..')) {
    console.error(`refusing suspicious manifest path: ${f.path}`);
    process.exit(1);
  }
}

// --- reconcile: content/ becomes exactly the manifest (plus .gitkeep files) ---
const keep = [];
const collectKeeps = (dir) => {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectKeeps(p);
    else if (e.name === '.gitkeep') keep.push(p);
  }
};
collectKeeps('content');

rmSync('content', { recursive: true, force: true });
for (const k of keep) {
  mkdirSync(path.dirname(k), { recursive: true });
  writeFileSync(k, '');
}
for (const f of manifest.files) {
  mkdirSync(path.dirname(f.path), { recursive: true });
  if (typeof f.content === 'string') writeFileSync(f.path, f.content);
  else if (typeof f.contentBase64 === 'string') writeFileSync(f.path, Buffer.from(f.contentBase64, 'base64'));
  else {
    console.error(`manifest entry has no content: ${f.path}`);
    process.exit(1);
  }
}

console.log(`reconciled ${manifest.files.length} file(s) into content/`);
