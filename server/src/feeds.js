// Build content/feed.xml (RSS 2.0) and content/sitemap.xml from the published
// index entries. Reader URLs follow the portfolio's hash routing
// (<siteUrl>/#blog/<slug>). Only emitted when a site URL is configured — an
// absolute base is required for both formats.

const xmlEscape = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const postUrl = (base, slug) => `${base}/#blog/${slug}`;

// entries are the parsed publishedJson objects: { slug, title, date, description, tags, ... }
export function buildFeeds(entries, { siteUrl, author, title = 'blog' }) {
  const base = String(siteUrl).replace(/\/+$/, '');
  if (!base) return [];

  const items = entries
    .map((e) => {
      const link = postUrl(base, e.slug);
      const pubDate = new Date(`${e.date}T00:00:00Z`).toUTCString();
      const cats = (e.tags ?? []).map((t) => `      <category>${xmlEscape(t)}</category>`).join('\n');
      return [
        '    <item>',
        `      <title>${xmlEscape(e.title)}</title>`,
        `      <link>${xmlEscape(link)}</link>`,
        `      <guid isPermaLink="true">${xmlEscape(link)}</guid>`,
        `      <pubDate>${pubDate}</pubDate>`,
        e.description ? `      <description>${xmlEscape(e.description)}</description>` : '',
        cats,
        '    </item>',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');

  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xmlEscape(title)}</title>
    <link>${xmlEscape(base)}</link>
    <atom:link href="${xmlEscape(base)}/feed.xml" rel="self" type="application/rss+xml" />
    <description>${xmlEscape(`Posts by ${author}`)}</description>
${items}
  </channel>
</rss>
`;

  const urls = entries
    .map((e) =>
      ['  <url>', `    <loc>${xmlEscape(postUrl(base, e.slug))}</loc>`, `    <lastmod>${e.date}</lastmod>`, '  </url>'].join(
        '\n'
      )
    )
    .join('\n');
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${xmlEscape(base)}/</loc>
  </url>
${urls}
</urlset>
`;

  return [
    { path: 'content/feed.xml', content: rss },
    { path: 'content/sitemap.xml', content: sitemap },
  ];
}
