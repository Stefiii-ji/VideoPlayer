import { useState } from 'react';

export default function LoginScreen({ onLogin }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      await onLogin(token);
      setToken('');
    } catch (loginError) {
      setError(loginError.message || 'Login failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="access-screen">
      <form className="access-card" onSubmit={submit}>
        <p className="eyebrow">MOVIESTREAM</p>
        <h1>Sign in</h1>
        <p>Enter the access token configured for this server.</p>
        <label htmlFor="access-token">Access token</label>
        <input
          id="access-token"
          type="password"
          autoComplete="current-password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          required
          autoFocus
        />
        {error && <p className="access-error" role="alert">{error}</p>}
        <button className="button button-primary" type="submit" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
