import { FormEvent, useEffect, useState } from 'react';
import { api } from '../api';
import type { Settings as SettingsType } from '../types';

export default function Settings({ demo }: { demo: boolean }) {
  const [settings, setSettings] = useState<SettingsType | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [pwMessage, setPwMessage] = useState('');
  const [pwError, setPwError] = useState('');

  const load = () => {
    api.getSettings().then(setSettings).catch((e) => setError(e.message));
  };
  useEffect(load, []);

  if (!settings) return <main className="page muted">{error || 'loading…'}</main>;

  const patch = (fields: Partial<SettingsType>) => {
    if (demo) return; // read-only demo — inputs render but never change
    setSettings({ ...settings, ...fields });
  };

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
        siteUrl: settings.siteUrl,
      });
      setMessage('saved.');
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const logoutEverywhere = async () => {
    if (demo) return;
    if (!confirm('Sign out every other session? Other browsers/devices will need to log in again.')) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await api.logoutAll();
      setMessage('signed out of all other sessions.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const changePassword = async (e: FormEvent) => {
    e.preventDefault();
    if (demo) return;
    setPwMessage('');
    setPwError('');
    setBusy(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      setPwMessage('password changed — other sessions were signed out.');
      setCurrentPassword('');
      setNewPassword('');
    } catch (err) {
      setPwError((err as Error).message);
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
          <label>
            site url
            <input
              value={settings.siteUrl}
              placeholder="https://your-blog.example — enables RSS + sitemap"
              onChange={(e) => patch({ siteUrl: e.target.value })}
            />
          </label>
        </div>
        <p className="muted">
          publishing needs no credentials here: posts are snapshotted in the database and the{' '}
          <a
            href="https://github.com/Z35Tyyyy/blog_blob/actions/workflows/sync-content.yml"
            target="_blank"
            rel="noopener noreferrer"
          >
            content sync workflow ↗
          </a>{' '}
          commits them to the repo with GitHub&apos;s own ephemeral token. the repo fields above
          only shape the image URLs written into published markdown.
        </p>
        {error && <p className="error">{error}</p>}
        {message && <p className="success">{message}</p>}
        <div className="row">
          <button type="submit" disabled={busy || demo}>
            save
          </button>
        </div>
      </form>
      <section className="stack settings-form">
        <h3>security</h3>
        <form onSubmit={changePassword} className="stack">
          <label>
            current password
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              disabled={demo}
            />
          </label>
          <label>
            new password
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              disabled={demo}
            />
          </label>
          {pwError && <p className="error">{pwError}</p>}
          {pwMessage && <p className="success">{pwMessage}</p>}
          <div className="row">
            <button type="submit" disabled={busy || demo || !currentPassword || !newPassword}>
              change password
            </button>
          </div>
        </form>
        <p className="muted">
          Signed in on a shared or lost device? Revoke every other session; you stay logged in here.
        </p>
        <div className="row">
          <button type="button" onClick={logoutEverywhere} disabled={busy || demo}>
            log out all other sessions
          </button>
        </div>
      </section>
    </main>
  );
}
