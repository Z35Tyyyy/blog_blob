// Helpers for turning a draft into a publishable markdown file.

export function slugify(title) {
  return (
    String(title)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '') // strip diacritics
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'untitled'
  );
}

/** Local calendar date as YYYY-MM-DD (toISOString would be UTC — wrong date
    for late-night writing in UTC+ timezones). */
export function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function readingTime(markdown) {
  const words = String(markdown)
    .replace(/```[\s\S]*?```/g, ' code ')
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 220));
}

const yamlString = (s) => JSON.stringify(String(s ?? ''));

export function buildFrontmatter(post) {
  const tags = Array.isArray(post.tags) ? post.tags : [];
  const lines = [
    '---',
    `title: ${yamlString(post.title)}`,
    `date: ${post.date}`,
  ];
  if (post.description) lines.push(`description: ${yamlString(post.description)}`);
  if (tags.length) lines.push(`tags: [${tags.map((t) => yamlString(t)).join(', ')}]`);
  if (post.cover) lines.push(`cover: ${yamlString(post.cover)}`);
  lines.push('---', '');
  return lines.join('\n');
}

/**
 * Find local upload references (/uploads/...) in the draft markdown, and
 * rewrite them to the raw.githubusercontent.com URLs they will have once
 * committed under content/images/<slug>/.
 *
 * Matches the URL substring anywhere (markdown image syntax, HTML <img>,
 * titles, reference definitions) rather than anchoring on `![...](...)` —
 * the server generates upload filenames from [a-z0-9.-] only, so the
 * charset-bounded match is unambiguous.
 *
 * Returns { markdown, images: [{ localUrl, repoPath }] }
 */
export function rewriteLocalImages(markdown, slug, { owner, repo, branch }) {
  const images = [];
  const seen = new Map();

  const rewritten = String(markdown).replace(/\/uploads\/[A-Za-z0-9._-]+/g, (url) => {
    let repoPath = seen.get(url);
    if (!repoPath) {
      const filename = url.split('/').pop();
      repoPath = `content/images/${slug}/${filename}`;
      seen.set(url, repoPath);
      images.push({ localUrl: url, repoPath });
    }
    return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${repoPath}`;
  });

  return { markdown: rewritten, images };
}
