// Inspect account roles, and restore admin access to a user that got the
// read-only demo role (a demo session can browse but never save or publish —
// if that happens to the account you administer with, the CMS looks broken).
//
// Run from server/:
//   node --env-file=.env scripts/promote-admin.mjs            # list users + roles
//   node --env-file=.env scripts/promote-admin.mjs <username> # make that user admin
import { MongoClient } from 'mongodb';

if (!process.env.MONGODB_URI) {
  console.error('MONGODB_URI is required (run with node --env-file=.env)');
  process.exit(1);
}

const username = process.argv[2];
const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db = client.db(process.env.MONGODB_DB || 'blog_blob');
const users = db.collection('users');

if (!username) {
  const all = await users
    .find({}, { projection: { username: 1, role: 1, createdAt: 1 } })
    .toArray();
  if (all.length === 0) {
    console.log('no users yet — the editor will show the first-run setup screen');
  }
  for (const u of all) {
    const created = u.createdAt instanceof Date ? u.createdAt.toISOString() : 'unknown';
    console.log(`${u.username}  role=${u.role ?? 'admin'}  created=${created}`);
  }
  await client.close();
  process.exit(0);
}

// absent role = admin, matching how first-run setup creates the account
const res = await users.updateOne({ username }, { $unset: { role: '' } });
if (res.matchedCount === 0) {
  console.error(`no user named "${username}"`);
  await client.close();
  process.exit(1);
}
console.log(`"${username}" is now an admin`);
await client.close();
