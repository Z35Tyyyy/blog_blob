---
title: "hello, world (the blog is alive)"
date: 2026-07-04
description: "In which I finally build the blog I've been threatening to write for a year."
tags: ["meta"]
---

Every developer has a half-finished blog. This one took me roughly a year of
"I'll start writing next week" before I gave up and built the entire publishing
pipeline instead — because apparently writing a CMS is easier than writing a
first paragraph.

## what this is

A place for:

- CTF writeups, once the embargoes lift
- things I broke and what the breaking taught me
- aviation tangents nobody asked for
- notes-to-self that might accidentally help you too

## how it works

The stack is deliberately boring. Posts are markdown files in a git repo. A
small editor commits them through the GitHub API, and the portfolio renders
them client-side:

```text
editor → git commit → raw.githubusercontent.com → your browser
```

No database on the reading path, no analytics, no cookie banner. If you can
`curl` it, you can read it.

> The best blog engine is the one that doesn't give you an excuse to stop
> writing. We'll see how that theory holds up.

That's it for post zero. If you're reading this, the pipeline works — which
means I'm officially out of excuses.
