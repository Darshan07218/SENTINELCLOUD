import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.jsx";
import { ApiError } from "../lib/api.js";
import AuthLayout from "../components/AuthLayout.jsx";
import { Alert, Icon } from "../components/ui.jsx";

// Phase 12: no role picker. Sign-up always creates a CITIZEN (read-only)
// account — enforced by auth-service, not by this form; a SYSTEM_ADMIN
// grants other roles on the Users page.

export default function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: "", password: "", fullName: "" });
  const [error, setError] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);

  function update(field) {
    return (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    setSubmitting(true);
    try {
      await register(form);
      setSuccess(true);
      setTimeout(() => navigate("/login"), 1200);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        if (err.details) {
          const byField = {};
          for (const d of err.details) byField[d.field] = d.message;
          setFieldErrors(byField);
        }
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
        <h1>Create an account</h1>
        <p className="sc-auth-sub">Join the SentinelCloud emergency response platform.</p>

        {success && <Alert tone="ok">Account created — redirecting to sign in…</Alert>}
        {error && <Alert>{error}</Alert>}

        <div className="sc-field">
          <label className="sc-label" htmlFor="fullName">
            Full name
          </label>
          <div className="sc-input-wrap">
            <Icon name="user" />
            <input id="fullName" required value={form.fullName} onChange={update("fullName")} className="sc-input" placeholder="Jane Doe" />
          </div>
          {fieldErrors.fullName && <FieldError message={fieldErrors.fullName} />}
        </div>

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
              value={form.email}
              onChange={update("email")}
              className="sc-input"
            />
          </div>
          {fieldErrors.email && <FieldError message={fieldErrors.email} />}
        </div>

        <div className="sc-field">
          <label className="sc-label" htmlFor="password">
            Password
          </label>
          <div className="sc-input-wrap">
            <Icon name="lock" />
            <input
              id="password"
              type="password"
              required
              autoComplete="new-password"
              placeholder="At least 10 characters"
              value={form.password}
              onChange={update("password")}
              className="sc-input"
            />
          </div>
          <p className="sc-hint">At least 10 characters, with an uppercase letter, a lowercase letter, and a digit.</p>
          {fieldErrors.password && <FieldError message={fieldErrors.password} />}
        </div>

        <Alert tone="info" role="note">
          New accounts start with read-only access. A system administrator grants operator or administrator roles.
        </Alert>

        <button type="submit" disabled={submitting} className="sc-btn is-block">
          {submitting ? (
            <>
              <span className="sc-spinner" aria-hidden="true" /> Creating account…
            </>
          ) : (
            <>
              Create account <Icon name="arrowRight" />
            </>
          )}
        </button>

        <p className="sc-auth-foot">
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </form>
    </AuthLayout>
  );
}

function FieldError({ message }) {
  return <p className="sc-field-error">{message}</p>;
}
