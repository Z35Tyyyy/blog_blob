# blog_blob

The engine room of [kanishk's blog](https://github.com/Z35Tyyyy/CyberPort) — a
self-hosted blog CMS plus the published content it produces.

```
blog_blob/
├── content/        ← published blog content (this is what the portfolio reads)
│   ├── posts.json  ← index of published posts
│   ├── posts/      ← one markdown file per post (with frontmatter)
│   └── images/     ← post images, one folder per slug
├── server/         ← Express + SQLite backend (auth, drafts, uploads, publish)
└── editor/         ← React + Vite editor UI (markdown, live preview, publish)
```

## How it works

1. You write posts in the **editor** (markdown, live preview, image uploads).
2. Drafts live in **MongoDB** (draft images in GridFS) — nothing is public
   until you hit **Publish**.
3. Publishing commits the post's markdown, its images, and a regenerated
   `content/posts.json` **to this repo** via the GitHub API (using a personal
   access token you configure in Settings).
4. The portfolio's blog page fetches `content/posts.json` and the markdown
   from `raw.githubusercontent.com` and renders it client-side.

## Running locally

Requirements: Node 20+, a MongoDB connection string (Atlas free tier works;
`npm test` uses an in-memory MongoDB and needs nothing).

```bash
# 1. backend
cd server
npm install
cp .env.example .env   # fill in MONGODB_URI
npm run dev            # http://localhost:4000

# 2. editor (in another terminal)
cd editor
npm install
npm run dev            # http://localhost:5173 (proxies /api to :4000)
```

First run: the editor asks you to create the admin account, then log in.

## Deployment (MongoDB Atlas + Render + Vercel)

### 1. MongoDB Atlas — the database

1. Create a free **M0 cluster** at [cloud.mongodb.com](https://cloud.mongodb.com).
2. **Database Access** → add a database user (username + strong password).
3. **Network Access** → allow `0.0.0.0/0` (Render's free tier has no static
   egress IPs; the connection is still TLS + authenticated).
4. **Connect → Drivers** → copy the connection string; that's `MONGODB_URI`.

### 2. Render — the backend

1. [dashboard.render.com](https://dashboard.render.com) → **New → Blueprint**
   → connect this repo. Render reads `render.yaml` and creates the
   `blog-blob-api` web service.
2. Set the two prompted env vars:
   - `MONGODB_URI` — the Atlas string from step 1
   - `ALLOWED_ORIGINS` — your Vercel URL (add it after step 3, e.g.
     `https://blog-blob.vercel.app`)
3. Deploy. Health check: `https://<service>.onrender.com/api/status`.

### 3. Vercel — the editor frontend

1. [vercel.com/new](https://vercel.com/new) → import this repo.
2. Set **Root Directory** to `editor/` (framework: Vite; defaults are fine).
3. If your Render service URL differs from `blog-blob-api.onrender.com`,
   update both rewrite destinations in `editor/vercel.json` first.
4. Deploy, then put the resulting URL into Render's `ALLOWED_ORIGINS`.

`vercel.json` rewrites `/api/*` and `/uploads/*` to Render, so the browser
only ever talks to the Vercel origin — cookies stay first-party and no CORS
is involved.

### Free-tier notes

- Render free services **spin down after ~15 min idle**; the first request
  then takes ~30-60s. A free [UptimeRobot](https://uptimerobot.com) monitor
  pinging `/api/status` every 10 minutes keeps it warm.
- Atlas M0 (512 MB) has no automatic backups — `mongodump` occasionally if
  the drafts matter to you. Published content is always safe in this repo.

### Publish settings

In the editor's **Settings** page configure:

- **GitHub token** — fine-grained PAT with *Contents: Read and write* on this
  repo only. Stored in the local database, never committed.
- **Repo** — defaults to `Z35Tyyyy/blog_blob`, branch `main`.
- **Author name** — shown in post bylines.

## Content format

`content/posts/<slug>.md`:

```markdown
---
title: "Some Post"
date: 2026-07-04
description: "One-liner shown in previews."
tags: [ctf, writeup]
---

Body markdown…
```

`content/posts.json` is an array of `{slug, title, date, description, tags,
cover, readingTime}` sorted newest-first. Image URLs inside published markdown
are absolute `raw.githubusercontent.com` URLs, so any markdown renderer can
display them.
