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
2. Drafts live in a local SQLite database (`server/data/app.db`) — nothing is
   public until you hit **Publish**.
3. Publishing commits the post's markdown, its images, and a regenerated
   `content/posts.json` **to this repo** via the GitHub API (using a personal
   access token you configure in Settings).
4. The portfolio's blog page fetches `content/posts.json` and the markdown
   from `raw.githubusercontent.com` and renders it client-side.

## Running the suite

Requirements: Node 20+.

```bash
# 1. backend
cd server
npm install
npm run dev          # http://localhost:4000

# 2. editor (in another terminal)
cd editor
npm install
npm run dev          # http://localhost:5173 (proxies /api to :4000)
```

First run: the editor asks you to create the admin account, then log in.

### Production

```bash
cd editor && npm run build   # outputs editor/dist
cd ../server && npm start    # serves the API and editor/dist on :4000
```

Deploy `server/` (with the built `editor/dist`) anywhere Node runs —
Railway, Render, Fly, a VPS. Set `PORT` if needed. The SQLite database and
uploaded images live in `server/data/` (gitignored — back it up).

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
