import { FormEvent, useEffect, useState } from 'react';
import { api } from '../api';
import type { Settings as SettingsType } from '../types';

export default function Settings() {
  const [settings, setSettings] = useState<SettingsType | null>(null);
  const [token, setToken] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => {
    api.getSettings().then(setSettings).catch((e) => setError(e.message));
  };
  useEffect(load, []);

  if (!settings) return <main className="page muted">{error || 'loading…'}</main>;

  const patch = (fields: Partial<SettingsType>) => setSettings({ ...settings, ...fields });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await api.saveSettings({
        owner: settings.owner,
        repo: settings.repo,
        branch: settings.branch,
        authorName: settings.authorName,
        ...(token.trim() ? { githubToken: token.trim() } : {}),
      });
      setToken('');
      setMessage('saved.');
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await api.testSettings();
      setMessage(`token works — push access to ${result.fullName} confirmed.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page">
      <h2>
        <span className="asterisk">*</span> settings
      </h2>
      <form onSubmit={submit} className="stack settings-form">
        <div className="meta-grid">
          <label>
            repo owner
            <input value={settings.owner} onChange={(e) => patch({ owner: e.target.value })} />
          </label>
          <label>
            repo name
            <input value={settings.repo} onChange={(e) => patch({ repo: e.target.value })} />
          </label>
          <label>
            branch
            <input value={settings.branch} onChange={(e) => patch({ branch: e.target.value })} />
          </label>
          <label>
            author name
            <input
              value={settings.authorName}
              onChange={(e) => patch({ authorName: e.target.value })}
            />
          </label>
        </div>
        <label>
          github token {settings.hasToken && <span className="pill pill-published">saved</span>}
          <input
            type="password"
            value={token}
            placeholder={settings.hasToken ? '•••••••• (leave blank to keep current)' : 'ghp_… or github_pat_…'}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
          />
        </label>
        <p className="muted">
          fine-grained personal access token with <strong>Contents: Read and write</strong> on the
          content repo only. it is stored in the local database and never committed anywhere.
        </p>
        {error && <p className="error">{error}</p>}
        {message && <p className="success">{message}</p>}
        <div className="row">
          <button type="submit" disabled={busy}>
            save
          </button>
          <button type="button" className="ghost" onClick={test} disabled={busy || !settings.hasToken}>
            test connection
          </button>
        </div>
      </form>
    </main>
  );
}
