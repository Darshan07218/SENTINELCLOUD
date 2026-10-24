import React, { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../auth/AuthContext.jsx";
import { fetchUsers, updateUser } from "../lib/api.js";
import { latestOnly } from "../lib/settle.js";
import { Alert, Badge, Card, Icon, PageHeader, SkeletonRows, StatCard } from "../components/ui.jsx";

/**
 * Phase 12: user management for SYSTEM_ADMINs.
 *
 * Public sign-up only creates CITIZEN (read-only) accounts, so this is
 * where operators and administrators get their roles. Every change is
 * enforced and audit-logged by auth-service (PATCH /auth/users/:id); this
 * page is just the form for it. A role or status change ends the user's
 * sessions, so they sign in again with the new role.
 */
const ROLES = [
  { value: "CITIZEN", label: "Citizen (read-only)" },
  { value: "EMERGENCY_OPERATOR", label: "Emergency operator" },
  { value: "HOSPITAL_ADMIN", label: "Hospital administrator" },
  { value: "INFRASTRUCTURE_ADMIN", label: "Infrastructure administrator" },
  { value: "SYSTEM_ADMIN", label: "System administrator" },
];

const ROLE_COLORS = {
  CITIZEN: "#8b9bb3",
  EMERGENCY_OPERATOR: "#f97316",
  HOSPITAL_ADMIN: "#22c55e",
  INFRASTRUCTURE_ADMIN: "#eab308",
  SYSTEM_ADMIN: "#c084fc",
};

const PAGE_SIZE = 50;

function initials(name = "") {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0].toUpperCase())
      .join("") || "?"
  );
}

export default function UsersPage() {
  const { authFetch, user: me } = useAuth();
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ users: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [savingId, setSavingId] = useState(null);
  const [notice, setNotice] = useState(null);

  // Paging quickly must not let an older page's response win.
  const pageRequests = useRef(latestOnly()).current;
  const load = useCallback(async () => {
    const tag = pageRequests.next();
    setLoading(true);
    try {
      const res = await authFetch((t) => fetchUsers(t, { page, limit: PAGE_SIZE }));
      if (!pageRequests.isLatest(tag)) return;
      setData({ users: res.users, total: res.total });
      setError(null);
    } catch (err) {
      if (pageRequests.isLatest(tag)) setError(err.message);
    } finally {
      if (pageRequests.isLatest(tag)) setLoading(false);
    }
  }, [authFetch, page, pageRequests]);

  useEffect(() => {
    load();
  }, [load]);

  async function change(target, changes, description) {
    if (changes.role === "SYSTEM_ADMIN" && !window.confirm(`Give ${target.email} full administrator access?`)) return;
    setSavingId(target.id);
    setNotice(null);
    try {
      const { user: updated } = await authFetch((t) => updateUser(t, target.id, changes));
      setData((d) => ({ ...d, users: d.users.map((u) => (u.id === updated.id ? updated : u)) }));
      setNotice(`${target.email}: ${description}. Their open sessions were ended.`);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingId(null);
    }
  }

  const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  const activeOnPage = data.users.filter((u) => u.isActive).length;
  const adminsOnPage = data.users.filter((u) => u.role === "SYSTEM_ADMIN").length;

  return (
    <section>
      <PageHeader
        eyebrow="Platform · Admin"
        icon="users"
        title="Users"
        subtitle="New accounts start as citizens with read-only access. Grant a role here when someone needs to dispatch ambulances, manage a hospital or blood bank, or run the power grid. Changing a role or deactivating an account signs that person out everywhere."
      />

      {error && <Alert>{error}</Alert>}
      {notice && <Alert tone="ok">{notice}</Alert>}

      <div className="sc-stats sc-stagger">
        <StatCard label="Total Accounts" value={data.total} icon="users" />
        <StatCard label="Active (this page)" value={activeOnPage} icon="check" color="#22c55e" />
        <StatCard label="Admins (this page)" value={adminsOnPage} icon="key" color="#c084fc" />
      </div>

      <Card title="Accounts" icon="user" subtitle={pages > 1 ? `Page ${page} of ${pages}` : `${data.total} account(s)`} className="sc-card-flush" style={{ padding: 0 }}>
        <div className="sc-table-scroll">
          <table className="sc-table" style={{ minWidth: 760 }}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Account</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {loading && data.users.length === 0 && (
                <tr>
                  <td colSpan={4}>
                    <SkeletonRows />
                  </td>
                </tr>
              )}
              {data.users.map((u) => {
                const self = u.id === me?.id;
                const busy = savingId === u.id;
                return (
                  <tr key={u.id} style={{ opacity: u.isActive ? 1 : 0.55 }}>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <span className="sc-avatar" style={{ background: `linear-gradient(135deg, ${ROLE_COLORS[u.role] || "#0ea5e9"}, #1e293b)` }} aria-hidden="true">
                          {initials(u.fullName)}
                        </span>
                        <div style={{ minWidth: 0 }}>
                          <div className="sc-cell-strong">
                            {u.fullName}
                            {self && <span style={{ color: "var(--accent)", fontWeight: 500 }}> (you)</span>}
                          </div>
                          <div className="sc-cell-sub">{u.email}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <select
                        aria-label={`Role for ${u.email}`}
                        value={u.role}
                        disabled={self || busy}
                        onChange={(e) => change(u, { role: e.target.value }, `role changed to ${e.target.value}`)}
                        className="sc-select is-sm"
                        style={{ minWidth: 220, borderColor: `${ROLE_COLORS[u.role] || "#8b9bb3"}55` }}
                      >
                        {ROLES.map((r) => (
                          <option key={r.value} value={r.value}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <Badge label={u.isActive ? "Active" : "Inactive"} color={u.isActive ? "#22c55e" : "#64748b"} small />
                        <button
                          type="button"
                          disabled={self || busy}
                          onClick={() => change(u, { isActive: !u.isActive }, u.isActive ? "account deactivated" : "account reactivated")}
                          className="sc-btn is-tone is-sm"
                          style={{ "--btn-color": u.isActive ? "#ef4444" : "#22c55e" }}
                        >
                          {busy ? <span className="sc-spinner" aria-hidden="true" /> : null}
                          {u.isActive ? "Deactivate" : "Reactivate"}
                        </button>
                      </div>
                    </td>
                    <td className="sc-mono" style={{ color: "var(--muted)", fontSize: "0.8rem" }}>
                      {new Date(u.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {pages > 1 && (
        <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", marginTop: "1rem", color: "var(--muted)", fontSize: "0.85rem" }}>
          <button type="button" className="sc-btn is-ghost is-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            <Icon name="chevron" style={{ transform: "rotate(180deg)" }} /> Previous
          </button>
          <span className="sc-mono">
            {page} / {pages}
          </span>
          <button type="button" className="sc-btn is-ghost is-sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
            Next <Icon name="chevron" />
          </button>
        </div>
      )}
    </section>
  );
}
