import crypto from 'node:crypto';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { UPLOADS_DIR } from './db.js';

const ALLOWED = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const ext = ALLOWED[file.mimetype];
    const base = path
      .basename(file.originalname, path.extname(file.originalname))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'image';
    cb(null, `${base}-${crypto.randomBytes(4).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  // cb(null, false) skips the file but keeps draining the request stream,
  // so the client gets a clean 400 instead of a connection reset.
  fileFilter: (req, file, cb) => cb(null, !!ALLOWED[file.mimetype]),
});

export const uploadsRouter = Router();

uploadsRouter.post('/', (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) {
      return res
        .status(400)
        .json({ error: 'no valid image supplied — png, jpeg, gif, webp only (field name: image)' });
    }
    res.status(201).json({ url: `/uploads/${req.file.filename}` });
  });
});
