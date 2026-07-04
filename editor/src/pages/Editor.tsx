import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import CodeMirror, { ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { markdown as mdLang } from '@codemirror/lang-markdown';
import { EditorView, keymap } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { api } from '../api';
import type { Post, PublishResult } from '../types';

type Mode = 'edit' | 'split' | 'preview';
type SaveState = 'saved' | 'unsaved' | 'saving' | 'error';

export default function Editor() {
  const { id } = useParams();

  const [post, setPost] = useState<Post | null>(null);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<Mode>('split');
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [lastSaved, setLastSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const [publishResult, setPublishResult] = useState<PublishResult | null>(null);

  const cmRef = useRef<ReactCodeMirrorRef>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const postRef = useRef<Post | null>(null);
  postRef.current = post;
  // generation counter: incremented on every edit so a save that resolves
  // after further typing doesn't falsely mark the doc 'saved'
  const dirtyRef = useRef(0);
  const saveStateRef = useRef<SaveState>('saved');
  saveStateRef.current = saveState;

  const isDark = document.documentElement.getAttribute('data-theme') !== 'light';

  useEffect(() => {
    api
      .getPost(id!)
      .then(setPost)
      .catch((e) => setError(e.message));
  }, [id]);

  const patch = (fields: Partial<Post>) => {
    dirtyRef.current += 1;
    setPost((p) => (p ? { ...p, ...fields } : p));
    setSaveState('unsaved');
  };

  const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

  const save = useCallback(async () => {
    const p = postRef.current;
    if (!p) return null;
    const generation = dirtyRef.current;
    setSaveState('saving');
    try {
      const updated = await api.updatePost(p.id, {
        title: p.title,
        // a transiently invalid slug (mid-typing) must not block saving the rest
        ...(SLUG_RE.test(p.slug) ? { slug: p.slug } : {}),
        ...(p.date ? { date: p.date } : {}),
        description: p.description,
        tags: p.tags,
        cover: p.cover,
        markdown: p.markdown,
      });
      // adopt the server-normalized slug only if the user hasn't retyped it since
      setPost((cur) =>
        cur
          ? { ...cur, status: updated.status, ...(cur.slug === p.slug ? { slug: updated.slug } : {}) }
          : cur
      );
      // edits made while the request was in flight keep the doc dirty
      setSaveState(dirtyRef.current === generation ? 'saved' : 'unsaved');
      setLastSaved(new Date().toLocaleTimeString());
      setError('');
      return updated;
    } catch (e) {
      setSaveState('error');
      setError((e as Error).message);
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // autosave (debounced)
  useEffect(() => {
    if (saveState !== 'unsaved') return;
    const t = setTimeout(save, 1200);
    return () => clearTimeout(t);
  }, [post, saveState, save]);

  // warn before closing with anything not persisted (including failed saves)
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (saveState !== 'saved') {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [saveState]);

  // SPA navigation (back link, topbar) unmounts this component without
  // beforeunload — flush any pending edits instead of dropping them
  useEffect(
    () => () => {
      if (saveStateRef.current === 'unsaved' || saveStateRef.current === 'error') void save();
    },
    [save]
  );

  // ---- markdown insertion helpers ----
  const wrapSelection = useCallback((before: string, after: string, placeholder: string) => {
    const view = cmRef.current?.view;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const selected = view.state.sliceDoc(from, to) || placeholder;
    view.dispatch({
      changes: { from, to, insert: before + selected + after },
      selection: { anchor: from + before.length, head: from + before.length + selected.length },
    });
    view.focus();
  }, []);

  const insertBlock = useCallback((text: string) => {
    const view = cmRef.current?.view;
    if (!view) return;
    const { from } = view.state.selection.main;
    const doc = view.state.doc;
    const line = doc.lineAt(from);
    // keep the block separated by blank lines on both sides — otherwise
    // markdown lazy continuation glues neighbors into the block ('> quote\ntext')
    // and '---' under a text line parses as a setext heading
    const prevNonBlank = line.number > 1 && doc.line(line.number - 1).text.trim().length > 0;
    const nextNonBlank = line.number < doc.lines && doc.line(line.number + 1).text.trim().length > 0;
    const prefix = line.text.trim().length > 0 ? '\n\n' : prevNonBlank ? '\n' : '';
    const suffix = nextNonBlank ? '\n\n' : '';
    view.dispatch({
      changes: { from: line.to, insert: prefix + text + suffix },
      selection: { anchor: line.to + prefix.length + text.length },
    });
    view.focus();
  }, []);

  const uploadFiles = useCallback(
    async (files: FileList | File[]) => {
      for (const file of Array.from(files)) {
        if (!file.type.startsWith('image/')) continue;
        try {
          const { url } = await api.upload(file);
          const alt = file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
          insertBlock(`![${alt}](${url})`);
        } catch (e) {
          setError(`upload failed: ${(e as Error).message}`);
        }
      }
    },
    [insertBlock]
  );

  // paste/drop images straight into the editor
  const pasteExtension = useMemo(
    () =>
      EditorView.domEventHandlers({
        paste: (event) => {
          const files = event.clipboardData?.files;
          if (files && files.length > 0) {
            event.preventDefault();
            void uploadFiles(files);
            return true;
          }
          return false;
        },
        drop: (event) => {
          const files = event.dataTransfer?.files;
          if (files && files.length > 0) {
            event.preventDefault();
            void uploadFiles(files);
            return true;
          }
          return false;
        },
      }),
    [uploadFiles]
  );

  const shortcuts = useMemo(
    () =>
      Prec.high(
        keymap.of([
          { key: 'Mod-b', run: () => (wrapSelection('**', '**', 'bold'), true) },
          { key: 'Mod-i', run: () => (wrapSelection('*', '*', 'italic'), true) },
          { key: 'Mod-k', run: () => (wrapSelection('[', '](https://)', 'link text'), true) },
          { key: 'Mod-s', run: () => (void save(), true) },
        ])
      ),
    [wrapSelection, save]
  );

  const extensions = useMemo(
    () => [mdLang(), EditorView.lineWrapping, pasteExtension, shortcuts],
    [pasteExtension, shortcuts]
  );

  const previewHtml = useMemo(() => {
    if (!post) return '';
    // same hardened config as the portfolio's renderer, so preview == production
    return DOMPurify.sanitize(marked.parse(post.markdown, { async: false }) as string, {
      FORBID_TAGS: ['style', 'form', 'input', 'button', 'select', 'textarea'],
      FORBID_ATTR: ['id', 'name'],
    });
  }, [post]);

  const words = useMemo(
    () => (post ? post.markdown.split(/\s+/).filter(Boolean).length : 0),
    [post]
  );

  // ---- publish / unpublish ----
  const doPublish = async () => {
    if (!post) return;
    setBusy(true);
    setError('');
    setPublishResult(null);
    try {
      const saved = await save();
      if (!saved) return;
      const result = await api.publish(post.id);
      setPublishResult(result);
      setPost((p) => (p ? { ...p, status: 'published' } : p));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doUnpublish = async () => {
    if (!post) return;
    if (!window.confirm('unpublish this post? it will disappear from the live blog.')) return;
    setBusy(true);
    setError('');
    try {
      await api.unpublish(post.id);
      setPost((p) => (p ? { ...p, status: 'draft' } : p));
      setPublishResult(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (error && !post) {
    return (
      <main className="page">
        <p className="error">{error}</p>
        <Link to="/">← back to posts</Link>
      </main>
    );
  }
  if (!post) return <main className="page muted">loading…</main>;

  const toolbar: Array<[string, string, () => void]> = [
    ['B', 'bold (ctrl+b)', () => wrapSelection('**', '**', 'bold')],
    ['I', 'italic (ctrl+i)', () => wrapSelection('*', '*', 'italic')],
    ['<>', 'inline code', () => wrapSelection('`', '`', 'code')],
    ['H2', 'heading 2', () => insertBlock('## Heading')],
    ['H3', 'heading 3', () => insertBlock('### Heading')],
    ['🔗', 'link (ctrl+k)', () => wrapSelection('[', '](https://)', 'link text')],
    ['🖼', 'insert image', () => fileRef.current?.click()],
    ['❝', 'blockquote', () => insertBlock('> quote')],
    ['••', 'bullet list', () => insertBlock('- one\n- two\n- three')],
    ['1.', 'numbered list', () => insertBlock('1. one\n2. two\n3. three')],
    ['```', 'code block', () => insertBlock('```\ncode\n```')],
    ['▦', 'table', () => insertBlock('| col | col |\n| --- | --- |\n| a | b |')],
    ['—', 'divider', () => insertBlock('---')],
  ];

  return (
    <main className="editor-page">
      <div className="editor-meta">
        <div className="meta-row">
          <Link to="/" className="muted back-link">← posts</Link>
          <span className={`pill pill-${post.status}`}>{post.status}</span>
          <span className="muted save-indicator">
            {saveState === 'saved' && lastSaved && `saved · ${lastSaved}`}
            {saveState === 'saved' && !lastSaved && 'saved'}
            {saveState === 'unsaved' && 'unsaved changes…'}
            {saveState === 'saving' && 'saving…'}
            {saveState === 'error' && <span className="error">save failed</span>}
          </span>
          <div className="meta-actions">
            {post.status === 'published' && (
              <button className="ghost" onClick={doUnpublish} disabled={busy}>
                unpublish
              </button>
            )}
            <button onClick={doPublish} disabled={busy}>
              {busy ? '…' : post.status === 'published' ? 'republish' : 'publish'}
            </button>
          </div>
        </div>

        <input
          className="title-input"
          value={post.title}
          placeholder="Post title"
          onChange={(e) => patch({ title: e.target.value })}
        />

        <div className="meta-grid">
          <label>
            slug
            <input
              value={post.slug}
              disabled={post.status === 'published'}
              title={post.status === 'published' ? 'unpublish to change the slug' : ''}
              onChange={(e) => patch({ slug: e.target.value })}
            />
          </label>
          <label>
            date
            <input type="date" value={post.date} onChange={(e) => patch({ date: e.target.value })} />
          </label>
          <label>
            tags (comma separated)
            <input
              value={post.tags.join(', ')}
              onChange={(e) =>
                patch({ tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })
              }
            />
          </label>
          <label>
            description
            <input
              value={post.description}
              placeholder="one-liner for previews"
              onChange={(e) => patch({ description: e.target.value })}
            />
          </label>
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      {publishResult && (
        <div className="publish-banner">
          published as <code>{publishResult.slug}</code> (commit{' '}
          <code>{publishResult.commit.slice(0, 7)}</code>) —{' '}
          <a href={publishResult.rawUrl} target="_blank" rel="noopener noreferrer">
            raw markdown ↗
          </a>
          <button className="ghost" onClick={() => setPublishResult(null)}>
            ✕
          </button>
        </div>
      )}

      <div className="editor-toolbar">
        {toolbar.map(([label, title, action]) => (
          <button key={title} className="ghost tool" title={title} onClick={action}>
            {label}
          </button>
        ))}
        <span className="spacer" />
        {(['edit', 'split', 'preview'] as Mode[]).map((m) => (
          <button
            key={m}
            className={`ghost tool ${mode === m ? 'active' : ''}`}
            onClick={() => setMode(m)}
          >
            {m}
          </button>
        ))}
      </div>

      <div className={`editor-panes mode-${mode}`}>
        {mode !== 'preview' && (
          <div className="pane pane-editor">
            <CodeMirror
              ref={cmRef}
              value={post.markdown}
              onChange={(value) => patch({ markdown: value })}
              extensions={extensions}
              theme={isDark ? oneDark : undefined}
              placeholder="write. the empty page is undefeated, but so are you."
              basicSetup={{ lineNumbers: false, foldGutter: false }}
            />
          </div>
        )}
        {mode !== 'edit' && (
          <div className="pane pane-preview">
            <article className="preview-body" dangerouslySetInnerHTML={{ __html: previewHtml }} />
          </div>
        )}
      </div>

      <div className="editor-status muted">
        {words} words · ~{Math.max(1, Math.ceil(words / 220))} min read
        {post.status === 'published' && (
          <> · live at <code>#blog/{post.slug}</code></>
        )}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files) void uploadFiles(e.target.files);
          e.target.value = '';
        }}
      />
    </main>
  );
}
