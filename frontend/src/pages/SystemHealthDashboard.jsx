import React, { useEffect, useState, useCallback } from "react";
import { fetchGatewayHealth, fetchAllServiceHealth, fetchCurrentUser } from "../lib/api.js";
import { useAuth } from "../auth/AuthContext.jsx";
import { Alert, Card, Icon, LiveDot, PageHeader, SkeletonRows, StatCard } from "../components/ui.jsx";

const STATUS_COLORS = {
  ok: "#22c55e",
  up: "#22c55e",
  UP: "#22c55e",
  ready: "#22c55e",
  degraded: "#f59e0b",
  DOWN: "#ef4444",
  down: "#ef4444",
  not_ready: "#ef4444",
  unknown: "#64748b",
};

const statusColor = (status) => STATUS_COLORS[status] || STATUS_COLORS.unknown;
const isHealthy = (status) => statusColor(status) === STATUS_COLORS.ok;

export default function SystemHealthDashboard() {
  const { authFetch } = useAuth();
  const [gatewayStatus, setGatewayStatus] = useState(null);
  const [services, setServices] = useState(null);
  const [error, setError] = useState(null);
  const [lastChecked, setLastChecked] = useState(null);
  const [profile, setProfile] = useState(null);
  const [profileError, setProfileError] = useState(null);

  const poll = useCallback(async () => {
    try {
      const [gateway, servicesResp] = await Promise.all([fetchGatewayHealth(), fetchAllServiceHealth()]);
      setGatewayStatus(gateway);
      setServices(servicesResp.services);
      setError(null);
      setLastChecked(new Date());
    } catch (err) {
      setError(err.message);
    }
  }, []);

  // 5 s matches the gateway's own cache of /health/services; a hidden tab
  // stops polling and refreshes as soon as it is visible again.
  useEffect(() => {
    poll();
    const interval = setInterval(() => {
      if (!document.hidden) poll();
    }, 5000);
    const onVisible = () => {
      if (!document.hidden) poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [poll]);

  // Demonstrates a real *authorized* request: GET /api/v1/auth/me
  // through the gateway, which requires a valid access token (the
  // gateway's requireAuth middleware rejects it otherwise — see
  // services/gateway/src/middleware/auth.js). authFetch also handles
  // a silent token refresh transparently if the access token has
  // expired since login.
  useEffect(() => {
    (async () => {
      try {
        const result = await authFetch((token) => fetchCurrentUser(token));
        setProfile(result.user);
        setProfileError(null);
      } catch (err) {
        setProfileError(err.message);
      }
    })();
  }, [authFetch]);

  const entries = services ? Object.entries(services) : [];
  const healthyCount = entries.filter(([, info]) => isHealthy(info.status)).length;

  return (
    <section>
      <PageHeader
        eyebrow="Platform"
        icon="activity"
        title="System Health"
        subtitle="The gateway's public health endpoints, polled every 5 seconds."
        actions={
          <span className="sc-clock">
            <LiveDot color={error ? "#ef4444" : "#22c55e"} live={!error} />
            {lastChecked ? `checked ${lastChecked.toLocaleTimeString()}` : "checking…"}
          </span>
        }
      />

      {error && (
        <Alert>
          Could not reach the gateway: {error}. Confirm the stack is running with <code>docker compose up --build</code> and that the
          gateway is healthy on port 8080.
        </Alert>
      )}

      <div className="sc-stats sc-stagger">
        <StatCard
          label="API Gateway"
          value={gatewayStatus ? String(gatewayStatus.status).toUpperCase() : "UNREACHABLE"}
          icon="globe"
          color={statusColor(gatewayStatus?.status || "unknown")}
          accent
        />
        <StatCard label="Services Healthy" value={services ? healthyCount : null} sublabel={services ? `of ${entries.length} services` : undefined} icon="server" color="#22c55e" />
        <StatCard
          label="Services Degraded"
          value={services ? entries.length - healthyCount : null}
          icon="alert"
          color={services && entries.length - healthyCount > 0 ? "#ef4444" : "#22c55e"}
          accent={services && entries.length - healthyCount > 0}
        />
      </div>

      <div
        className="sc-stagger sc-section"
        style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: "0.9rem" }}
      >
        {entries.map(([name, info]) => {
          const color = statusColor(info.status);
          return (
            <div key={name} className="sc-stat" style={{ "--stat-color": color }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span className="sc-stat-icon">
                  <Icon name="server" />
                </span>
                <strong style={{ textTransform: "capitalize", fontSize: "0.9rem", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {name.replace(/-/g, " ")}
                </strong>
                <LiveDot color={color} live={isHealthy(info.status)} />
              </div>
              <div className="sc-mono" style={{ marginTop: 10, fontSize: "0.78rem", color, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                {info.status}
              </div>
              {info.error && <div style={{ fontSize: "0.74rem", color: "#fca5a5", marginTop: 4, overflowWrap: "anywhere" }}>{info.error}</div>}
              <span className="sc-stat-bar" aria-hidden="true" />
            </div>
          );
        })}
        {!services && !error && (
          <div className="sc-card" style={{ gridColumn: "1 / -1" }}>
            <SkeletonRows />
          </div>
        )}
      </div>

      <Card title="Your Session" icon="key" subtitle="Authorized request demo">
        {profile && (
          <div style={{ fontSize: "0.86rem", color: "var(--text-2)", lineHeight: 1.6 }}>
            <code>GET /api/v1/auth/me</code> succeeded with your access token — signed in as{" "}
            <strong style={{ color: "var(--text)" }}>{profile.fullName}</strong> (<span style={{ color: "var(--accent)" }}>{profile.role}</span>).
          </div>
        )}
        {profileError && <Alert>Could not fetch profile: {profileError}</Alert>}
        {!profile && !profileError && <SkeletonRows rows={1} />}
        <p className="sc-hint" style={{ marginTop: "1rem" }}>
          The service grid above polls the gateway's public <code>/health</code> endpoints every 5 seconds. This panel proves the
          authenticated path: it calls a protected endpoint (<code>/api/v1/auth/me</code>) through the gateway using your access
          token, which the gateway's auth middleware verifies before proxying the request onward.
        </p>
      </Card>
    </section>
  );
}
