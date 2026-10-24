import React from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./AuthContext.jsx";
import { Alert, Loading } from "../components/ui.jsx";

/**
 * Wraps a page that requires authentication. Redirects to /login,
 * remembering where the user was headed so they land back there after
 * signing in. If `roles` is given, also enforces that the user's role
 * is in the list — but this is a UX convenience only (hiding a link
 * the user couldn't use anyway); it is NOT the actual security
 * boundary. The real enforcement happens server-side in the gateway's
 * requireAuth/requireRole middleware (services/gateway/src/middleware/auth.js),
 * since any client-side check can trivially be bypassed by calling the
 * API directly.
 */
export default function ProtectedRoute({ children, roles }) {
  const { isAuthenticated, loading, user } = useAuth();
  const location = useLocation();

  if (loading) {
    return <Loading label="Checking your session…" />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (roles && !roles.includes(user.role)) {
    return <Alert>Your account role ({user.role}) doesn't have access to this page.</Alert>;
  }

  return children;
}
