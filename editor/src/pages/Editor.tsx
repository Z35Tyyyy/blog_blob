import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import CodeMirror, { ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { markdown as mdLang } from '@codemirror/lang-markdown';
import { EditorView, keymap } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { renderMarkdown } from '../lib/markdown';
import { api } from '../api';
import type { Post, PublishResult, Revision, RevisionSummary } from '../types';

type Mode = 'edit' | 'split' | 'preview';
type SaveState = 'saved' | 'unsaved' | 'saving' | 'error';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// phones: writing space is scarce — start in edit mode and keep the meta
// fields folded away until asked for
const NARROW = '(max-width: 860px)';

export default function Editor({ demo }: { demo: boolean }) {
  const { id } = useParams();

  const [post, setPost] = useState<Post | null>(null);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<Mode>(() => (window.matchMedia(NARROW).matches ? 'edit' : 'split'));
  const [metaOpen, setMetaOpen] = useState(() => !window.matchMedia(NARROW).matches);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [lastSaved, setLastSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const [publishResult, setPublishResult] = useState<PublishResult | null>(null);
  const [zen, setZen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [revisions, setRevisions] = useState<RevisionSummary[] | null>(null);
  const [revPreview, setRevPreview] = useState<Revision | null>(null);
  const [conflict, setConflict] = useState(false);
  const [scheduleAt, setScheduleAt] = useState('');

  const cmRef = useRef<ReactCodeMirrorRef>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const coverRef = useRef<HTMLInputElement>(null);
  const postRef = useRef<Post | null>(null);
  postRef.current = post;
  // generation counter: incremented on every edit so a save that resolves
  // after further typing doesn't falsely mark the doc 'saved'
  const dirtyRef = useRef(0);
  const saveStateRef = useRef<SaveState>('saved');
  saveStateRef.current = saveState;

  const [isDark, setIsDark] = useState(
    () => document.documentElement.getAttribute('data-theme') !== 'light'
  );
  useEffect(() => {
    const obs = new MutationObserver(() =>
      setIsDark(document.documentElement.getAttribute('data-theme') !== 'light')
    );
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    api
      .getPost(id!)
      .then(setPost)
      .catch((e) => setError(e.message));
  }, [id]);

  const patch = (fields: Partial<Post>) => {
    // read-only demo: inputs and the editor render, but nothing mutates or
    // autosaves — the choke point keeps every field controlled-and-frozen
    if (demo) return;
    dirtyRef.current += 1;
    setPost((p) => (p ? { ...p, ...fields } : p));
    setSaveState('unsaved');
  };

  const save = useCallback(async () => {
    const p = postRef.current;
    if (!p || demo || conflict) return null; // don't overwrite a version we know is stale
    const generation = dirtyRef.current;
    setSaveState('saving');
    try {
      const updated = await api.updatePost(
        p.id,
        {
          title: p.title,
          // a transiently invalid slug (mid-typing) must not block saving the rest
          ...(SLUG_RE.test(p.slug) ? { slug: p.slug } : {}),
          ...(p.date ? { date: p.date } : {}),
          description: p.description,
          tags: p.tags,
          cover: p.cover,
          markdown: p.markdown,
        },
        p.updated_at
      );
      // adopt the server-normalized slug only if the user hasn't retyped it since,
      // and always adopt the fresh updated_at so the next save's base is current
      setPost((cur) =>
        cur
          ? {
              ...cur,
              status: updated.status,
              updated_at: updated.updated_at,
              ...(cur.slug === p.slug ? { slug: updated.slug } : {}),
            }
          : cur
      );
      // edits made while the request was in flight keep the doc dirty
      setSaveState(dirtyRef.current === generation ? 'saved' : 'unsaved');
      setLastSaved(new Date().toLocaleTimeString());
      setError('');
      return updated;
    } catch (e) {
      const status = (e as Error & { status?: number }).status;
      if (status === 409) setConflict(true);
      setSaveState('error');
      setError((e as Error).message);
      return null;
    }
  }, [demo, conflict]);

  const reloadPost = async () => {
    try {
      const fresh = await api.getPost(id!);
      setPost(fresh);
      setConflict(false);
      setSaveState('saved');
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  };

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

  // esc leaves zen mode
  useEffect(() => {
    if (!zen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setZen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [zen]);

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

  const uploadCover = async (file: File) => {
    if (!file.type.startsWith('image/')) return;
    try {
      const { url } = await api.upload(file);
      patch({ cover: url });
    } catch (e) {
      setError(`upload failed: ${(e as Error).message}`);
    }
  };

  // ---- revision checkpoints ----
  const toggleHistory = async () => {
    if (showHistory) {
      setShowHistory(false);
      setRevPreview(null);
      return;
    }
    setShowHistory(true);
    setRevisions(null);
    try {
      setRevisions(await api.listRevisions(id!));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const viewRevision = async (revId: string) => {
    try {
      setRevPreview(await api.getRevision(id!, revId));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const restoreRevision = () => {
    if (!revPreview) return;
    if (!window.confirm('replace the current draft content with this checkpoint?')) return;
    patch({ markdown: revPreview.markdown });
    setRevPreview(null);
    setShowHistory(false);
  };

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

  const previewHtml = useMemo(() => (post ? renderMarkdown(post.markdown) : ''), [post]);

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
      const publishAt = scheduleAt ? new Date(scheduleAt).toISOString() : null;
      const result = await api.publish(post.id, publishAt);
      setPublishResult(result);
      // reflect the scheduled/published state locally; publishAt only "sticks"
      // server-side when it's in the future
      const future = !!publishAt && new Date(publishAt).getTime() > Date.now();
      setPost((p) => (p ? { ...p, status: 'published', publish_at: future ? publishAt : null } : p));
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
      setPost((p) => (p ? { ...p, status: 'draft', publish_at: null } : p));
      setScheduleAt('');
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
    ['~~', 'strikethrough', () => wrapSelection('~~', '~~', 'struck')],
    ['<>', 'inline code', () => wrapSelection('`', '`', 'code')],
    ['H2', 'heading 2', () => insertBlock('## Heading')],
    ['H3', 'heading 3', () => insertBlock('### Heading')],
    ['🔗', 'link (ctrl+k)', () => wrapSelection('[', '](https://)', 'link text')],
    ['🖼', 'insert image', () => fileRef.current?.click()],
    ['❝', 'blockquote', () => insertBlock('> quote')],
    ['••', 'bullet list', () => insertBlock('- one\n- two\n- three')],
    ['1.', 'numbered list', () => insertBlock('1. one\n2. two\n3. three')],
    ['☑', 'task list', () => insertBlock('- [ ] task')],
    ['```', 'code block', () => insertBlock('```\ncode\n```')],
    ['▦', 'table', () => insertBlock('| col | col |\n| --- | --- |\n| a | b |')],
    ['—', 'divider', () => insertBlock('---')],
  ];

  const scheduled =
    post.status === 'published' && !!post.publish_at && new Date(post.publish_at).getTime() > Date.now();

  return (
    <main className={`editor-page${zen ? ' zen' : ''}`}>
      <div className="editor-meta">
        <div className="meta-row">
          <Link to="/" className="muted back-link">← posts</Link>
          <span className={`pill pill-${scheduled ? 'scheduled' : post.status}`}>
            {scheduled ? 'scheduled' : post.status}
          </span>
          <span className="muted save-indicator">
            {saveState === 'saved' && lastSaved && `saved · ${lastSaved}`}
            {saveState === 'saved' && !lastSaved && 'saved'}
            {saveState === 'unsaved' && 'unsaved changes…'}
            {saveState === 'saving' && 'saving…'}
            {saveState === 'error' && <span className="error">save failed</span>}
          </span>
          {!demo && (
            <div className="meta-actions">
              {post.status !== 'published' && (
                <input
                  type="datetime-local"
                  className="schedule-input"
                  value={scheduleAt}
                  onChange={(e) => setScheduleAt(e.target.value)}
                  title="optional: schedule when this goes live"
                />
              )}
              {post.status === 'published' && (
                <button className="ghost" onClick={doUnpublish} disabled={busy}>
                  unpublish
                </button>
              )}
              <button onClick={doPublish} disabled={busy}>
                {busy ? '…' : post.status === 'published' ? 'republish' : scheduleAt ? 'schedule' : 'publish'}
              </button>
            </div>
          )}
        </div>

        <input
          className="title-input"
          value={post.title}
          placeholder="Post title"
          onChange={(e) => patch({ title: e.target.value })}
        />

        <details
          className="meta-details"
          open={metaOpen}
          onToggle={(e) => setMetaOpen((e.target as HTMLDetailsElement).open)}
        >
          <summary>post details</summary>
          <div className="meta-grid">
          <label>
            <span>
              slug
              {!SLUG_RE.test(post.slug) && (
                <span className="error"> · not saved — use a-z, 0-9, hyphens</span>
              )}
            </span>
            <input
              value={post.slug}
              disabled={post.status === 'published'}
              title={post.status === 'published' ? 'unpublish to change the slug' : ''}
              onChange={(e) => patch({ slug: e.target.value })}
            />
          </label>
          <label>
            <span>
              date
              {!post.date && <span className="error"> · empty — keeps last saved date</span>}
            </span>
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
          <label>
            cover image
            <div className="cover-field">
              <input
                value={post.cover}
                placeholder="https://… or upload →"
                onChange={(e) => patch({ cover: e.target.value })}
              />
              <button className="ghost" onClick={() => coverRef.current?.click()} title="upload cover image" disabled={demo}>
                ↑
              </button>
              {post.cover && !demo && (
                <button className="ghost danger" onClick={() => patch({ cover: '' })} title="remove cover">
                  ✕
                </button>
              )}
            </div>
            {post.cover && <img className="cover-thumb" src={post.cover} alt="cover preview" />}
          </label>
          </div>
        </details>
      </div>

      {conflict && (
        <div className="publish-banner conflict-banner">
          ⚠ this post was changed in another tab or device. reloading fetches the latest —
          any edits you made here since will be lost.
          <button onClick={reloadPost}>reload latest</button>
        </div>
      )}
      {error && !conflict && <p className="error">{error}</p>}

      {publishResult && (
        <div className="publish-banner">
          <code>{publishResult.slug}</code> queued — goes live on the next content sync
          (≤30 min), or{' '}
          <a
            href="https://github.com/Z35Tyyyy/blog_blob/actions/workflows/sync-content.yml"
            target="_blank"
            rel="noopener noreferrer"
          >
            run the sync now ↗
          </a>
          <button className="ghost" onClick={() => setPublishResult(null)}>
            ✕
          </button>
        </div>
      )}

      <div className="editor-toolbar">
        {toolbar.map(([label, title, action]) => (
          <button key={title} className="ghost tool" title={title} onClick={action} disabled={demo}>
            {label}
          </button>
        ))}
        <span className="spacer" />
        <button
          className={`ghost tool ${showHistory ? 'active' : ''}`}
          onClick={toggleHistory}
          title="revision checkpoints"
        >
          ↺ history
        </button>
        <button
          className={`ghost tool ${zen ? 'active' : ''}`}
          onClick={() => setZen((z) => !z)}
          title="distraction-free writing (esc exits)"
        >
          zen
        </button>
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

      {showHistory && (
        <div className="history-panel">
          <div className="history-head">
            <span>checkpoints</span>
            <span className="muted">
              the previous version is snapshotted when you save — at most one per 5 minutes, last 20 kept
            </span>
            <button className="ghost history-close" onClick={toggleHistory} title="close checkpoints">
              ✕
            </button>
          </div>
          {!revisions && <p className="muted">loading…</p>}
          {revisions && revisions.length === 0 && (
            <p className="muted">no checkpoints yet — they appear as you keep writing.</p>
          )}
          {revisions && revisions.length > 0 && (
            <ul className="history-list">
              {revisions.map((r) => (
                <li key={r.id}>
                  <button
                    className={`ghost tool ${revPreview?.id === r.id ? 'active' : ''}`}
                    onClick={() => viewRevision(r.id)}
                  >
                    {new Date(r.created_at).toLocaleString()} · {r.words} words
                  </button>
                </li>
              ))}
            </ul>
          )}
          {revPreview && (
            <div className="history-preview">
              <div className="history-preview-head">
                <span className="muted">
                  snapshot · {new Date(revPreview.created_at).toLocaleString()} · {revPreview.words} words
                </span>
                <button onClick={restoreRevision} disabled={demo}>restore this version</button>
                <button className="ghost" onClick={() => setRevPreview(null)}>
                  close
                </button>
              </div>
              <pre className="history-preview-body">{revPreview.markdown}</pre>
            </div>
          )}
        </div>
      )}

      <div className={`editor-panes mode-${mode}`}>
        {mode !== 'preview' && (
          <div className="pane pane-editor">
            <CodeMirror
              ref={cmRef}
              value={post.markdown}
              editable={!demo}
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
        {scheduled && <> · scheduled for {new Date(post.publish_at!).toLocaleString()}</>}
        {post.status === 'published' && !scheduled && (
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
      <input
        ref={coverRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files?.[0]) void uploadCover(e.target.files[0]);
          e.target.value = '';
        }}
      />
    </main>
  );
}
