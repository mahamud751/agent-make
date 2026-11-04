import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";

function AuthCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="auth">
      <div className="card auth-card">
        <div className="logo big">◆ AgentDesk</div>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

function useSubmit(fn: (f: FormData) => Promise<string>) {
  const { setToken } = useAuth();
  const nav = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await setToken(await fn(new FormData(e.currentTarget)));
      nav("/");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { onSubmit, error, busy };
}

export function LoginPage() {
  const { onSubmit, error, busy } = useSubmit(async (f) => (await api("/auth/login", { body: Object.fromEntries(f) })).token);
  return (
    <AuthCard title="Sign in">
      <form onSubmit={onSubmit} className="stack">
        <input name="email" type="email" placeholder="Email" required autoFocus />
        <input name="password" type="password" placeholder="Password" required />
        {error && <div className="error">{error}</div>}
        <button className="primary" disabled={busy}>Sign in</button>
      </form>
      <p className="muted">New here? <Link to="/signup">Create a workspace</Link></p>
    </AuthCard>
  );
}

export function SignupPage() {
  const { onSubmit, error, busy } = useSubmit(async (f) => (await api("/auth/signup", { body: Object.fromEntries(f) })).token);
  return (
    <AuthCard title="Create your workspace">
      <form onSubmit={onSubmit} className="stack">
        <input name="company" placeholder="Store / company name" required autoFocus />
        <input name="name" placeholder="Your name" required />
        <input name="email" type="email" placeholder="Work email" required />
        <input name="password" type="password" placeholder="Password (8+ characters)" minLength={8} required />
        {error && <div className="error">{error}</div>}
        <button className="primary" disabled={busy}>Create workspace</button>
      </form>
      <p className="muted">Already have an account? <Link to="/login">Sign in</Link></p>
    </AuthCard>
  );
}

export function AcceptInvitePage() {
  const [params] = useSearchParams();
  const { onSubmit, error, busy } = useSubmit(async (f) => (await api("/auth/invites/accept", { body: { token: params.get("token"), ...Object.fromEntries(f) } })).token);
  return (
    <AuthCard title="Join your team">
      <form onSubmit={onSubmit} className="stack">
        <input name="name" placeholder="Your name (new accounts)" />
        <input name="password" type="password" placeholder="Password" required />
        {error && <div className="error">{error}</div>}
        <button className="primary" disabled={busy}>Accept invite</button>
      </form>
    </AuthCard>
  );
}
