import React, { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.jsx";
import { ApiError } from "../lib/api.js";
import AuthLayout from "../components/AuthLayout.jsx";
import { Alert, Icon } from "../components/ui.jsx";

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const redirectTo = location.state?.from?.pathname || "/";

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      navigate(redirectTo, { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("Could not reach the server. Is the stack running?");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout>
      <form onSubmit={handleSubmit} className="sc-auth-card">
        <h1>Welcome back</h1>
        <p className="sc-auth-sub">Sign in to the SentinelCloud command center.</p>

        {error && <Alert>{error}</Alert>}

        <div className="sc-field">
          <label className="sc-label" htmlFor="email">
            Email
          </label>
          <div className="sc-input-wrap">
            <Icon name="mail" />
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              placeholder="you@agency.gov"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="sc-input"
            />
          </div>
        </div>

        <div className="sc-field" style={{ marginBottom: "1.5rem" }}>
          <label className="sc-label" htmlFor="password">
            Password
          </label>
          <div className="sc-input-wrap">
            <Icon name="lock" />
            <input
              id="password"
              type="password"
              required
              autoComplete="current-password"
              placeholder="••••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="sc-input"
            />
          </div>
        </div>

        <button type="submit" disabled={submitting} className="sc-btn is-block">
          {submitting ? (
            <>
              <span className="sc-spinner" aria-hidden="true" /> Signing in…
            </>
          ) : (
            <>
              Sign in <Icon name="arrowRight" />
            </>
          )}
        </button>

        <p className="sc-auth-foot">
          No account? <Link to="/register">Create one</Link>
        </p>
      </form>
    </AuthLayout>
  );
}
