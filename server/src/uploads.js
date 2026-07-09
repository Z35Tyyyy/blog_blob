import crypto from 'node:crypto';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { uploadsBucket } from './db.js';

const ALLOWED = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

// memory storage → GridFS: Render's free-tier disk is ephemeral
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  // cb(null, false) skips the file but keeps draining the request stream,
  // so the client gets a clean 400 instead of a connection reset.
  fileFilter: (req, file, cb) => cb(null, !!ALLOWED[file.mimetype]),
});

// Trust the bytes, not the client-declared Content-Type: an attacker can label
// anything `image/png`. Sniff the magic number and only accept our four formats.
function sniffImageMime(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && ['GIF87a', 'GIF89a'].includes(buf.subarray(0, 6).toString('latin1')))
    return 'image/gif';
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp';
  return null;
}

function makeFilename(originalname, mimetype) {
  const base =
    path
      .basename(originalname, path.extname(originalname))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'image';
  return `${base}-${crypto.randomBytes(4).toString('hex')}${ALLOWED[mimetype]}`;
}

export const uploadsRouter = Router();

uploadsRouter.post('/', (req, res, next) => {
  upload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) {
      return res
        .status(400)
        .json({ error: 'no valid image supplied — png, jpeg, gif, webp only (field name: image)' });
    }
    // Authoritative check: the actual bytes must be one of the allowed images,
    // regardless of the client-declared MIME the fileFilter already gated on.
    const mimetype = sniffImageMime(req.file.buffer);
    if (!mimetype || !ALLOWED[mimetype]) {
      return res
        .status(400)
        .json({ error: 'file contents are not a supported image — png, jpeg, gif, webp only' });
    }
    const filename = makeFilename(req.file.originalname, mimetype);
    const stream = uploadsBucket.openUploadStream(filename, {
      metadata: { contentType: mimetype },
    });
    stream.on('error', next);
    stream.on('finish', () => res.status(201).json({ url: `/uploads/${filename}` }));
    stream.end(req.file.buffer);
  });
});

/** Read an uploaded draft image out of GridFS as base64 (used at publish time). */
export async function readUploadBase64(filename) {
  const chunks = [];
  await new Promise((resolve, reject) => {
    uploadsBucket
      .openDownloadStreamByName(filename)
      .on('data', (c) => chunks.push(c))
      .on('error', (err) =>
        reject(
          err?.code === 'ENOENT' || /FileNotFound/i.test(String(err))
            ? new Error(`uploaded image missing: ${filename}`)
            : err
        )
      )
      .on('end', resolve);
  });
  return Buffer.concat(chunks).toString('base64');
}

/** Stream an uploaded draft image to the browser (auth-gated in index.js). */
export function serveUpload(req, res) {
  const filename = String(req.params.filename);
  uploadsBucket
    .find({ filename })
    .limit(1)
    .toArray()
    .then(([file]) => {
      if (!file) return res.status(404).json({ error: 'not found' });
      res.set('Content-Type', file.metadata?.contentType ?? 'application/octet-stream');
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Cache-Control', 'private, max-age=86400');
      uploadsBucket
        .openDownloadStreamByName(filename)
        .on('error', () => res.destroy())
        .pipe(res);
    })
    .catch(() => res.status(500).json({ error: 'internal error' }));
}
