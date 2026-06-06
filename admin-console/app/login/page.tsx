'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const params = useSearchParams();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        const from = params.get('from') || '/notifications';
        router.replace(from);
        router.refresh();
      } else {
        const j = await res.json().catch(() => ({}));
        setErr(j.message || 'Login failed.');
      }
    } catch {
      setErr('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="topbar" />
        <div className="body">
          <div className="logo">STATIONLY</div>
          <div className="label">Admin Console</div>
          <h1>Sign in</h1>
          <form onSubmit={submit}>
            <div className="field">
              <label htmlFor="pw">Password</label>
              <input
                id="pw"
                type="password"
                autoFocus
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Console password"
              />
            </div>
            <button className="btn-send" type="submit" disabled={busy || !password}>
              {busy ? 'Signing in…' : 'Enter'}
            </button>
            <div className="err">{err}</div>
          </form>
        </div>
      </div>
    </div>
  );
}
