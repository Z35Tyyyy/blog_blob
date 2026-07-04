import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api';
import type { AuthStatus } from './types';
import Login from './pages/Login';
import Posts from './pages/Posts';
import Editor from './pages/Editor';
import Settings from './pages/Settings';

function ThemeToggle() {
  const [theme, setTheme] = useState(document.documentElement.getAttribute('data-theme') ?? 'dark');
  const flip = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('bb_theme', next);
    setTheme(next);
  };
  return (
    <button className="ghost" onClick={flip} title="toggle theme">
      {theme === 'dark' ? '☀' : '☾'}
    </button>
  );
}

export default function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [error, setError] = useState('');
  const location = useLocation();

  const refresh = useCallback(() => {
    api
      .status()
      .then(setAuth)
      .catch((e) => setError(e.message));
  }, []);

  useEffect(refresh, [refresh]);

  if (error) {
    return (
      <div className="center-card">
        <h1>blog_blob</h1>
        <p className="muted">can’t reach the server: {error}</p>
        <p className="muted">is the backend running? <code>cd server && npm run dev</code></p>
        <button onClick={() => { setError(''); refresh(); }}>retry</button>
      </div>
    );
  }

  if (!auth) return <div className="center-card muted">loading…</div>;

  if (auth.setupNeeded || !auth.authenticated) {
    return <Login setupNeeded={auth.setupNeeded} onDone={refresh} />;
  }

  const logout = async () => {
    await api.logout();
    refresh();
  };

  return (
    <div className="shell">
      <nav className="topbar">
        <Link to="/" className="brand">
          <span className="asterisk">*</span> blog_blob
        </Link>
        <div className="topbar-right">
          <Link to="/" className={location.pathname === '/' ? 'active' : ''}>posts</Link>
          <Link to="/settings" className={location.pathname === '/settings' ? 'active' : ''}>settings</Link>
          <ThemeToggle />
          <button className="ghost" onClick={logout} title={`logged in as ${auth.username}`}>
            logout
          </button>
        </div>
      </nav>
      <Routes>
        <Route path="/" element={<Posts />} />
        <Route path="/edit/:id" element={<Editor />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
