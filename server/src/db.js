import { GridFSBucket, MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const dbName = process.env.MONGODB_DB || 'blog_blob';

const client = new MongoClient(uri);

/** @type {import('mongodb').Db} */
export let db;
/** @type {GridFSBucket} bucket for draft image uploads (Render disk is ephemeral) */
export let uploadsBucket;

export async function connect() {
  await client.connect();
  db = client.db(dbName);
  uploadsBucket = new GridFSBucket(db, { bucketName: 'uploads' });

  await Promise.all([
    db.collection('users').createIndex({ username: 1 }, { unique: true }),
    // TTL index: Mongo deletes expired sessions itself
    db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection('posts').createIndex({ slug: 1 }, { unique: true }),
    db.collection('revisions').createIndex({ postId: 1, createdAt: -1 }),
    db.collection('uploads.files').createIndex({ filename: 1 }),
  ]);

  return db;
}

export async function getSetting(key, fallback = '') {
  const row = await db.collection('settings').findOne({ _id: key });
  return row ? row.value : fallback;
}

export async function setSetting(key, value) {
  await db.collection('settings').updateOne({ _id: key }, { $set: { value } }, { upsert: true });
}
