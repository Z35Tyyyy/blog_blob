// One-time migration: register the repo's existing content/ files as
// publish snapshots in the database, so the sync-content workflow's first
// reconcile reproduces the tree instead of deleting posts it doesn't know.
//
// Run from server/ with the same env as the server:
//   node --env-file=.env scripts/seed-from-content.mjs
//
// Limitation: images referenced by old posts exist in the repo but not in
// GridFS on a fresh database, so they can't be re-attached; posts with
// images should be republished from the editor instead. (Posts without
// images — like the seed post — round-trip exactly.)

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const contentDir = path.join(__dirname, '..', '..', 'content');

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('MONGODB_URI is required (run with node --env-file=.env)');
  process.exit(1);
}
const client = new MongoClient(uri);
await client.connect();
const db = client.db(process.env.MONGODB_DB || 'blog_blob');

const index = JSON.parse(readFileSync(path.join(contentDir, 'posts.json'), 'utf8'));
let seeded = 0;
for (const entry of index) {
  const mdPath = path.join(contentDir, 'posts', `${entry.slug}.md`);
  // normalize CRLF from Windows checkouts — snapshots must be LF like the repo
  const publishedMarkdown = readFileSync(mdPath, 'utf8').replace(/\r\n/g, '\n');
  // body without the frontmatter block, for editing
  const body = publishedMarkdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');

  if (/raw\.githubusercontent\.com\/[^)"'\s]*\/content\/images\//.test(publishedMarkdown)) {
    console.warn(`⚠ ${entry.slug}: references repo images that are not in GridFS — republish it from the editor instead of seeding`);
    continue;
  }

  const now = new Date();
  const res = await db.collection('posts').updateOne(
    { slug: entry.slug },
    {
      $setOnInsert: { createdAt: now },
      $set: {
        slug: entry.slug,
        title: entry.title,
        description: entry.description ?? '',
        tags: entry.tags ?? [],
        cover: entry.cover ?? '',
        date: entry.date,
        markdown: body,
        status: 'published',
        publishedAt: now,
        updatedAt: now,
        publishedJson: JSON.stringify(entry),
        publishedMarkdown,
        publishedImages: [],
      },
    },
    { upsert: true }
  );
  seeded++;
  console.log(`✓ ${entry.slug} ${res.upsertedCount ? '(created)' : '(updated)'}`);
}
console.log(`${seeded}/${index.length} post(s) seeded`);
await client.close();
