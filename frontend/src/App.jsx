import React, { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate, Link, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/AuthContext.jsx";
import ProtectedRoute from "./auth/ProtectedRoute.jsx";
import LoginPage from "./pages/LoginPage.jsx";
import RegisterPage from "./pages/RegisterPage.jsx";
import SystemHealthDashboard from "./pages/SystemHealthDashboard.jsx";
import CommandCenter from "./pages/CommandCenter.jsx";
import HospitalDashboard from "./pages/HospitalDashboard.jsx";
import AmbulanceDashboard from "./pages/AmbulanceDashboard.jsx";
import BloodBankDashboard from "./pages/BloodBankDashboard.jsx";
import PowerDashboard from "./pages/PowerDashboard.jsx";
import EmergencyDashboard from "./pages/EmergencyDashboard.jsx";
import ResiliencePage from "./pages/ResiliencePage.jsx";
import SimulatorPage from "./pages/SimulatorPage.jsx";
import UsersPage from "./pages/UsersPage.jsx";
import { Backdrop, BrandMark, Icon } from "./components/ui.jsx";

const NAV = [
  {
    label: "Operations",
    items: [
      { to: "/", label: "Command Center", icon: "command" },
      { to: "/emergency", label: "Emergency", icon: "siren" },
    ],
  },
  {
    label: "Infrastructure",
    items: [
      { to: "/hospitals", label: "Hospitals", icon: "hospital" },
      { to: "/ambulances", label: "Ambulances", icon: "ambulance" },
      { to: "/blood-banks", label: "Blood Banks", icon: "droplet" },
      { to: "/power", label: "Power Grid", icon: "zap" },
    ],
  },
  {
    label: "Platform",
    items: [
      { to: "/system-health", label: "System Health", icon: "activity" },
      { to: "/resilience", label: "Resilience Demo", icon: "flask" },
      { to: "/simulator", label: "Simulator", icon: "activity", role: "SYSTEM_ADMIN" },
      { to: "/admin/users", label: "Users", icon: "users", role: "SYSTEM_ADMIN" },
    ],
  },
];

const ALL_ITEMS = NAV.flatMap((g) => g.items);

function initials(name = "") {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join("") || "?";
}

function NavLink({ to, icon, children, onNavigate }) {
  const location = useLocation();
  const active = location.pathname === to;
  return (
    <Link to={to} className="sc-nav-link" aria-current={active ? "page" : undefined} onClick={onNavigate}>
      <Icon name={icon} />
      <span>{children}</span>
    </Link>
  );
}

function Sidebar({ onNavigate }) {
  const { user, logout } = useAuth();
  return (
    <aside className="sc-sidebar" aria-label="Sidebar">
      <Link to="/" className="sc-brand" onClick={onNavigate}>
        <BrandMark />
        <div>
          <div className="sc-brand-name">SentinelCloud</div>
          <div className="sc-brand-tag">Response Platform</div>
        </div>
      </Link>

      <nav aria-label="Main" className="sc-nav">
        {NAV.map((group) => {
          const items = group.items.filter((i) => !i.role || i.role === user.role);
          if (items.length === 0) return null;
          return (
            <div key={group.label} className="sc-nav-group">
              <div className="sc-nav-label">{group.label}</div>
              {items.map((item) => (
                <NavLink key={item.to} to={item.to} icon={item.icon} onNavigate={onNavigate}>
                  {item.label}
                </NavLink>
              ))}
            </div>
          );
        })}
      </nav>

      <div className="sc-user-card">
        <span className="sc-avatar" aria-hidden="true">{initials(user.fullName)}</span>
        <div className="sc-user-meta">
          <div className="sc-user-name" title={user.email}>{user.fullName}</div>
          <div className="sc-user-role">{user.role.replace(/_/g, " ")}</div>
        </div>
        <button type="button" className="sc-icon-btn" onClick={() => logout()} aria-label="Log out" title="Log out">
          <Icon name="logout" />
        </button>
      </div>
    </aside>
  );
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="sc-clock sc-hide-narrow" aria-label="Current time">
      <Icon name="clock" size={14} />
      <time dateTime={now.toISOString()}>{now.toLocaleTimeString([], { hour12: false })}</time>
      <span className="sc-clock-zone">{now.toLocaleDateString([], { day: "2-digit", month: "short" })}</span>
    </div>
  );
}

function Topbar({ onMenu }) {
  const location = useLocation();
  const current = ALL_ITEMS.find((i) => i.to === location.pathname);
  return (
    <div className="sc-topbar">
      <button type="button" className="sc-icon-btn sc-menu-btn" onClick={onMenu} aria-label="Open navigation">
        <Icon name="menu" />
      </button>
      <div className="sc-crumbs">
        <span className="sc-hide-narrow">SentinelCloud</span>
        <Icon name="chevron" size={14} className="sc-hide-narrow" />
        <strong>{current?.label || "Overview"}</strong>
      </div>
      <div className="sc-topbar-right">
        <Clock />
      </div>
    </div>
  );
}

function AppShell() {
  const { user } = useAuth();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);

  // Close the mobile drawer on every route change.
  useEffect(() => setNavOpen(false), [location.pathname]);

  const isAuthRoute = location.pathname === "/login" || location.pathname === "/register";

  const routes = (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <CommandCenter />
          </ProtectedRoute>
        }
      />
      <Route
        path="/system-health"
        element={
          <ProtectedRoute>
            <SystemHealthDashboard />
          </ProtectedRoute>
        }
      />
      <Route
        path="/hospitals"
        element={
          <ProtectedRoute>
            <HospitalDashboard />
          </ProtectedRoute>
        }
      />
      <Route
        path="/ambulances"
        element={
          <ProtectedRoute>
            <AmbulanceDashboard />
          </ProtectedRoute>
        }
      />
      <Route
        path="/blood-banks"
        element={
          <ProtectedRoute>
            <BloodBankDashboard />
          </ProtectedRoute>
        }
      />
      <Route
        path="/power"
        element={
          <ProtectedRoute>
            <PowerDashboard />
          </ProtectedRoute>
        }
      />
      <Route
        path="/emergency"
        element={
          <ProtectedRoute>
            <EmergencyDashboard />
          </ProtectedRoute>
        }
      />
      <Route
        path="/simulator"
        element={
          // Phase 16: watching is harmless, but only a SYSTEM_ADMIN can start
          // anything (gateway + simulator-service), so the menu shows it to them.
          <ProtectedRoute>
            <SimulatorPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/resilience"
        element={
          // Any signed-in user can watch drills; starting one is
          // SYSTEM_ADMIN-only, enforced by the gateway and resilience-service.
          <ProtectedRoute>
            <ResiliencePage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/users"
        element={
          // Phase 12: role management. The real check is auth-service's
          // requireRole("SYSTEM_ADMIN"); this only hides the page.
          <ProtectedRoute roles={["SYSTEM_ADMIN"]}>
            <UsersPage />
          </ProtectedRoute>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );

  // Signed-out views (and the auth pages) get the full-bleed layout, no chrome.
  if (!user || isAuthRoute) {
    return (
      <>
        <Backdrop />
        <a className="sc-skip-link" href="#main">Skip to content</a>
        <main id="main" tabIndex={-1} style={{ position: "relative", zIndex: 1 }}>
          {routes}
        </main>
      </>
    );
  }

  return (
    <>
      <Backdrop />
      <a className="sc-skip-link" href="#main">Skip to content</a>
      <div className={`sc-shell${navOpen ? " is-nav-open" : ""}`}>
        <Sidebar onNavigate={() => setNavOpen(false)} />
        <div className="sc-scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />
        <div className="sc-content">
          <Topbar onMenu={() => setNavOpen(true)} />
          <main id="main" className="sc-main" tabIndex={-1}>
            <div key={location.pathname} className="sc-fade-up">
              {routes}
            </div>
          </main>
        </div>
      </div>
    </>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppShell />
      </AuthProvider>
    </BrowserRouter>
  );
}
