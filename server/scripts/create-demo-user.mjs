// Create (or reset) a read-only demo account. Demo sessions can browse the
// whole editor — posts, revisions, previews, settings — but every mutating
// request is rejected with 403 (see demoReadOnly in src/auth.js).
//
// Run from server/:
//   node --env-file=.env scripts/create-demo-user.mjs [username] [password]
// Defaults: demo / browse-only
import bcrypt from 'bcryptjs';
import { MongoClient } from 'mongodb';

const username = process.argv[2] || 'demo';
const password = process.argv[3] || 'browse-only';

if (!/^[\w.-]{3,32}$/.test(username)) {
  console.error('username: 3-32 chars, letters/digits/._-');
  process.exit(1);
}
if (password.length < 8) {
  console.error('password must be at least 8 characters');
  process.exit(1);
}
if (!process.env.MONGODB_URI) {
  console.error('MONGODB_URI is required (run with node --env-file=.env)');
  process.exit(1);
}

const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db = client.db(process.env.MONGODB_DB || 'blog_blob');

const existing = await db.collection('users').findOne({ username });
if (existing && (existing.role ?? 'admin') !== 'demo') {
  console.error(`user "${username}" exists and is not a demo account — refusing to downgrade it`);
  process.exit(1);
}

await db.collection('users').updateOne(
  { username },
  {
    $setOnInsert: { username, createdAt: new Date() },
    $set: { passwordHash: await bcrypt.hash(password, 10), role: 'demo' },
  },
  { upsert: true }
);
console.log(`demo account ready: ${username} (read-only)`);
await client.close();
