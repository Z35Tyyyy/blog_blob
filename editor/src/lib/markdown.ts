// Shared markdown → sanitized HTML renderer for the editor preview.
// marked builds the HTML, highlight.js colorizes fenced code blocks, and
// DOMPurify is the single trust boundary (same hardened config the preview has
// always used). Kept in one place so the config can't drift between callers.
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';

// A curated language set — enough for security/CTF writeups without pulling the
// full highlight.js bundle. Each language auto-registers its own aliases
// (js, ts, py, sh, yml, html, …), so `hljs.getLanguage('js')` resolves.
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import http from 'highlight.js/lib/languages/http';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const LANGUAGES = {
  bash, c, cpp, csharp, css, diff, go, http, ini, java, javascript, json,
  markdown, php, python, rust, shell, sql, typescript, xml, yaml,
};
for (const [name, def] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, def);

const md = new Marked(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      const language = lang && hljs.getLanguage(lang) ? lang : null;
      return language ? hljs.highlight(code, { language }).value : hljs.highlightAuto(code).value;
    },
  })
);

/** Render markdown to HTML that is safe to inject via dangerouslySetInnerHTML. */
export function renderMarkdown(source: string): string {
  const raw = md.parse(source ?? '', { async: false }) as string;
  return DOMPurify.sanitize(raw, {
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'select', 'textarea'],
    FORBID_ATTR: ['id', 'name'],
  });
}
