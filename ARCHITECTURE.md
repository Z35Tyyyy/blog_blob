# Architecture

How the blog suite fits together: what runs where, where data lives, and what
happens when you write, publish, and read a post.

## The big picture

Two repos, three moving parts, one static output:

```mermaid
flowchart LR
    subgraph you["✍️ You"]
        browser["Browser<br/>(editor UI)"]
    end

    subgraph vercel["Vercel"]
        editor["editor/<br/>React + Vite + CodeMirror<br/>SPA, static files"]
    end

    subgraph render["Render"]
        api["server/<br/>Express API<br/>auth · drafts · uploads · publish"]
    end

    subgraph atlas["MongoDB Atlas"]
        mongo[("users · sessions<br/>posts · revisions<br/>settings · GridFS uploads")]
    end

    subgraph github["GitHub: Z35Tyyyy/blog_blob"]
        content["content/<br/>posts.json · posts/*.md · images/"]
    end

    subgraph reader["🌍 Readers"]
        portfolio["CyberPort portfolio<br/>index.html #blog page"]
    end

    browser -->|"HTTPS"| editor
    editor -->|"/api/* and /uploads/*<br/>rewritten by vercel.json<br/>(same-origin → cookies work)"| api
    api <--> mongo
    api -->|"publish: snapshot in DB; the sync-content<br/>workflow commits via GitHub's<br/>ephemeral token (no PAT anywhere)"| content
    content -->|"raw.githubusercontent.com"| portfolio
```

Key idea: **drafting is private and dynamic** (MongoDB behind an authenticated
API), **reading is public and static** (plain files in this repo, fetched from
`raw.githubusercontent.com`). The portfolio never talks to the server — if
Render is asleep or gone, the published blog keeps working.

## The pieces

| Piece | Tech | Lives at | Job |
|---|---|---|---|
| `editor/` | React 18, Vite, TypeScript, CodeMirror 6, marked + DOMPurify | Vercel (static) | Writing UI: markdown editor, live preview, uploads, publish button |
| `server/` | Express, MongoDB native driver, multer | Render (free tier) | REST API: auth/sessions, draft CRUD, revision checkpoints, image uploads, publishing |
| `content/` | plain JSON + markdown + images | this repo, `main` branch | The published blog — the only thing readers ever touch |
| Blog page | vanilla JS in `index.html` | CyberPort repo | Fetches `content/posts.json` + `content/posts/<slug>.md`, renders with marked + DOMPurify |

### Why the Vercel rewrites matter

`editor/vercel.json` rewrites `/api/*` and `/uploads/*` to the Render URL.
The browser only ever sees one origin (the Vercel domain), so the session
cookie is first-party and there is no CORS involved. If the Render service
name changes, update those two destinations.

## Data model (MongoDB)

```mermaid
erDiagram
    users {
        string username UK
        string passwordHash "bcrypt"
    }
    sessions {
        string token
        date expiresAt "TTL index - Mongo auto-deletes"
    }
    posts {
        string slug UK
        string title
        string description
        string-array tags
        string cover
        string markdown "the live draft body"
        string status "draft | published"
        string date "YYYY-MM-DD"
        string publishedJson "frozen index entry from last publish"
    }
    revisions {
        objectId postId FK
        string markdown "checkpoint of a previous version"
        int words
        date createdAt
    }
    settings {
        string _id PK "github_token, github_owner, ..."
        string value
    }
    uploads_gridfs {
        string filename "GridFS bucket - draft images"
    }
    posts ||--o{ revisions : "max 20, throttled to 1 per 5 min"
    users ||--o{ sessions : ""
```

Two invariants worth knowing:

1. **`content/posts.json` is built from `publishedJson` snapshots, never from
   live rows.** Editing a published post does not change the public blog until
   you explicitly republish. Unpublishing deletes the snapshot.
2. **Draft images live in GridFS, not on disk** — Render's free-tier disk is
   ephemeral. They are served at `/uploads/<file>` behind auth (drafts are
   private), and only copied into the repo at publish time.

## Write path: what happens while you type

```mermaid
sequenceDiagram
    participant E as Editor (browser)
    participant A as API (Render)
    participant M as MongoDB

    E->>E: keystroke → state patch → "unsaved"
    Note over E: debounce 1.2s
    E->>A: PUT /api/posts/:id
    A->>M: read current post
    alt body changed & last checkpoint > 5 min old
        A->>M: insert revision (previous markdown, cap 20)
    end
    A->>M: update post
    A-->>E: normalized post → "saved"
    Note over E: paste/drop an image
    E->>A: POST /api/uploads (multipart)
    A->>M: stream into GridFS
    A-->>E: { url: "/uploads/<name>" } → inserted as ![alt](url)
```

Revision checkpoints (the `↺ history` panel in the editor) are snapshots of
the **previous** body taken when a save changes it — throttled so autosave
doesn't produce a revision per keystroke. Restoring one just replaces the
editor content; it still autosaves like any other edit.

## Publish path: draft → public blog

Publishing is a pure database operation; **no GitHub credential exists
anywhere in the system**. The `sync-content` GitHub Actions workflow
(cron every 30 min + a manual Run button) commits published content using
GitHub's own ephemeral `GITHUB_TOKEN`.

```mermaid
sequenceDiagram
    participant E as Editor
    participant A as API
    participant M as MongoDB
    participant W as sync-content workflow
    participant P as Portfolio (reader)

    E->>A: POST /api/posts/:id/publish
    A->>A: rewrite /uploads/... URLs →<br/>raw.githubusercontent.com/.../content/images/slug/...
    A->>M: snapshot: publishedJson (index entry),<br/>publishedMarkdown (frontmatter+body),<br/>publishedImages (GridFS refs)
    A-->>E: { queued: true }
    W->>A: (≤30 min later) GET /api/export/content<br/>Bearer EXPORT_KEY
    A->>M: read all published snapshots + images from GridFS
    A-->>W: manifest: the desired content/ tree
    W->>W: reconcile content/ to match, commit + push<br/>with the run's ephemeral GITHUB_TOKEN
    P->>W: (later) fetch posts.json + slug.md from raw.githubusercontent.com
```

The manifest is the *entire* desired `content/` tree, so publish, republish,
unpublish, and image pruning are all the same operation: make the tree equal
the manifest. Unpublishing just drops the snapshots — the next sync removes
the files. If the free-tier API is asleep and can't be woken, the run skips
cleanly and the next tick retries; a failed export commits nothing.

## Auth

First run shows a **setup** screen that creates the single admin user
(bcrypt-hashed). Login issues a random session token stored in Mongo with a
TTL index (Mongo deletes expired sessions itself) and set as an
`HttpOnly` cookie. Every `/api/posts`, `/api/uploads`, `/api/settings` route
sits behind that cookie. Mutating requests are additionally origin-checked
(same host, localhost, or an entry in `ALLOWED_ORIGINS`).

## Deployment & CI

Deploys ride the platforms' own git integrations (Vercel hobby + Render free
tier) — GitHub Actions only runs checks, and needs no secrets.

```mermaid
flowchart TD
    dev["push / merge PR to main"] --> gha["GitHub Actions ci.yml<br/>server smoke tests (28 checks,<br/>in-memory MongoDB) + editor tsc/vite build"]
    dev --> render["Render git integration<br/>rootDir server/ → rebuilds API<br/>only when server/ changes"]
    dev --> vercel["Vercel git integration<br/>ignoreCommand skips builds<br/>unless editor/ changed"]
    publish["CMS publish commit<br/>(touches only content/)"] -.->|"nothing rebuilds —<br/>content is served from GitHub"| dev
```

| Where | What | Credentials it needs |
|---|---|---|
| Render service env | runtime config for `server/` | `MONGODB_URI`, `MONGODB_DB`, `ALLOWED_ORIGINS` (see `render.yaml`) |
| CMS Settings page | publishing | GitHub PAT with write access to this repo (stored in Mongo `settings`) |
| GitHub Actions | `ci.yml` checks only | none |

Publish commits from the CMS only touch `content/**` and deliberately do
**not** trigger a rebuild anywhere: `ci.yml` ignores that path, Render only
watches `server/` (its root directory), and `editor/vercel.json`'s
`ignoreCommand` tells Vercel to skip builds when nothing under `editor/`
changed. The content itself is served straight from GitHub.

## Repo map

```
blog_blob/
├── .github/workflows/   ci.yml — checks on PRs and pushes to main
├── content/             ← the published blog (what readers fetch)
│   ├── posts.json         index, regenerated on every (un)publish
│   ├── posts/<slug>.md    frontmatter + body
│   └── images/<slug>/     images referenced by that post
├── editor/              ← Vite SPA
│   ├── src/api.ts          typed fetch wrapper for every endpoint
│   ├── src/pages/          Login · Posts (list/search) · Editor · Settings
│   └── vercel.json         /api + /uploads rewrites to Render
├── server/              ← Express API
│   ├── src/index.js        app wiring, CSRF/origin guard, static editor build
│   ├── src/auth.js         setup/login/sessions
│   ├── src/posts.js        draft CRUD + revision checkpoints
│   ├── src/uploads.js      multer → GridFS
│   ├── src/publish.js      publish/unpublish orchestration
│   ├── src/github.js       Git Data API (blobs → tree → commit → ref)
│   ├── src/markdown.js     slugify, frontmatter, image URL rewriting
│   └── test/smoke.mjs      end-to-end API suite on mongodb-memory-server
└── render.yaml          Render blueprint for the API service
```
