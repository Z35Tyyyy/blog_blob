import { FormEvent, useState } from 'react';
import { api } from '../api';

const DEMO_USER = 'demo';
const DEMO_PASS = 'browse-only';

export default function Login({
  setupNeeded,
  setupTokenRequired,
  onDone,
}: {
  setupNeeded: boolean;
  setupTokenRequired: boolean;
  onDone: () => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (setupNeeded && password !== confirm) {
      setError('passwords don’t match');
      return;
    }
    setBusy(true);
    try {
      if (setupNeeded) await api.setup(username, password, setupTokenRequired ? setupToken : undefined);
      else await api.login(username, password);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const enterAsDemo = async () => {
    setError('');
    setBusy(true);
    try {
      await api.login(DEMO_USER, DEMO_PASS);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center-card">
      <h1>
        <span className="asterisk">*</span> blog_blob
      </h1>
      <p className="muted">
        {setupNeeded
          ? 'first run — create the admin account.'
          : 'the blog engine room. identify yourself.'}
      </p>
      <form onSubmit={submit} className="stack">
        <label>
          username
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </label>
        <label>
          password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={setupNeeded ? 'new-password' : 'current-password'}
            required
            minLength={setupNeeded ? 8 : undefined}
          />
        </label>
        {setupNeeded && (
          <label>
            confirm password
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              required
            />
          </label>
        )}
        {setupNeeded && setupTokenRequired && (
          <label>
            setup token
            <input
              type="password"
              value={setupToken}
              onChange={(e) => setSetupToken(e.target.value)}
              autoComplete="off"
              required
            />
          </label>
        )}
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? '…' : setupNeeded ? 'create account' : 'log in'}
        </button>
      </form>

      {!setupNeeded && (
        <div className="demo-note">
          <p className="muted">
            just exploring? enter as <code>{DEMO_USER}</code> / <code>{DEMO_PASS}</code> — browse
            everything, but publishing is disabled.
          </p>
          <button type="button" className="ghost" onClick={enterAsDemo} disabled={busy}>
            enter as demo
          </button>
        </div>
      )}
    </div>
  );
}
