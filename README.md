# blog_blob

The engine room of [kanishk's blog](https://github.com/Z35Tyyyy/CyberPort) — a
self-hosted blog CMS plus the published content it produces.

```
blog_blob/
├── content/        ← published blog content (this is what the portfolio reads)
│   ├── posts.json  ← index of published posts
│   ├── posts/      ← one markdown file per post (with frontmatter)
│   └── images/     ← post images, one folder per slug
├── server/         ← Express + MongoDB backend (auth, drafts, uploads, publish)
└── editor/         ← React + Vite editor UI (markdown, live preview, publish)
```

## How it works

1. You write posts in the **editor** (markdown, live preview, image uploads).
2. Drafts live in **MongoDB** (draft images in GridFS) — nothing is public
   until you hit **Publish**.
3. Publishing snapshots the post (final markdown + images) **in the
   database**; the `sync-content` GitHub Actions workflow then commits it to
   this repo using GitHub's own ephemeral token — **no PAT exists anywhere**.
   Posts go live on the next sync tick (≤30 min) or instantly via the
   workflow's *Run workflow* button.
4. The portfolio's blog page fetches `content/posts.json` and the markdown
   from `raw.githubusercontent.com` and renders it client-side.

Diagrams of all of this — components, data model, write/publish flows,
deployment — live in [ARCHITECTURE.md](ARCHITECTURE.md).

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
     `https://<your-project>.vercel.app`)

   (`MONGODB_DB` is preset to `blog_blob` in `render.yaml`.)
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

### CI & deploys

- `ci.yml` (GitHub Actions) runs the server smoke suite and the editor build
  on every PR and every push to `main`. No secrets needed.
- **Deploys are handled by the platforms' own git integrations** — once
  connected (steps 2 and 3 above), Render and Vercel each redeploy on push
  to `main` by themselves.
- Blog publish commits (which only touch `content/**`) don't redeploy
  anything: Render only rebuilds on changes under its root dir `server/`,
  and `editor/vercel.json`'s `ignoreCommand` skips Vercel builds when
  nothing under `editor/` changed.

### Content sync (how posts reach the repo)

`sync-content.yml` runs every 30 minutes (and on demand via *Run workflow*).
It wakes the API, fetches the desired `content/` tree from
`GET /api/export/content`, reconciles the folder, and commits with the run's
ephemeral `GITHUB_TOKEN` — publish, republish, unpublish, and image cleanup
are all just "make the tree match".

One-time setup:

1. Generate a long random string; set it as **`EXPORT_KEY`** in two places:
   the Render env var and the repo's Actions secret (Settings → Secrets and
   variables → Actions).
2. If the Render URL differs from `blog-blob-api.onrender.com`, set the repo
   *variable* `SYNC_API_URL`.

While the secret is missing or the free-tier API can't be woken, runs skip
cleanly (green with a notice) — nothing breaks, the next tick retries.

### Publish settings

In the editor's **Settings** page configure:

- **Repo** — defaults to `Z35Tyyyy/blog_blob`, branch `main`; used only to
  shape the `raw.githubusercontent.com` image URLs written into published
  markdown.
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
