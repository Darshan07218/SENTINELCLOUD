import React, { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { useAuth } from "../auth/AuthContext.jsx";
import {
  fetchGatewayHealth,
  fetchAllServiceHealth,
  fetchHospitalSummary,
  fetchHospitals,
  fetchHospitalAlerts,
  fetchAmbulanceSummary,
  fetchAmbulances,
  fetchActiveEmergencies,
  fetchBloodBankSummary,
  fetchBloodBanks,
  fetchShortageAlerts,
  fetchPowerSummary,
  fetchPowerMap,
  fetchPowerAlerts,
  fetchActiveDisasters,
  fetchDisasters,
  fetchRecentEvents,
} from "../lib/api.js";
import { connectLiveFeed } from "../lib/socket.js";
import { eventColor, eventLabel, eventTime, isEventEnvelope, mergeEvents } from "../lib/events.js";
import { TIER_COLORS, tierColor, tierLabel, toTier, worstTier } from "../lib/statusTier.js";
import { BarChart, DonutChart, GaugeBar } from "../components/MiniCharts.jsx";
import CommandMap from "../components/CommandMap.jsx";
import { Alert, Card, Empty, Icon, LiveDot, PageHeader, SkeletonRows, Tile, TierBadge } from "../components/ui.jsx";

const INFRA_TYPES = [
  { value: "ALL", label: "All Infrastructure" },
  { value: "HOSPITAL", label: "Hospitals" },
  { value: "AMBULANCE", label: "Ambulances" },
  { value: "BLOOD_BANK", label: "Blood Banks" },
  { value: "POWER", label: "Power Grid" },
  { value: "DISASTER", label: "Disasters" },
];

const INFRA_ICONS = { HOSPITAL: "hospital", AMBULANCE: "ambulance", BLOOD_BANK: "droplet", POWER: "zap", DISASTER: "flame" };

const SEVERITY_FILTERS = [
  { value: "ALL", label: "All Severities" },
  { value: "NORMAL", label: "Normal" },
  { value: "WARNING", label: "Warning" },
  { value: "HIGH", label: "High" },
  { value: "CRITICAL", label: "Critical" },
];

const TIME_RANGES = [
  { value: "15m", label: "Last 15 min", ms: 15 * 60 * 1000 },
  { value: "1h", label: "Last hour", ms: 60 * 60 * 1000 },
  { value: "24h", label: "Last 24 hours", ms: 24 * 60 * 60 * 1000 },
  { value: "ALL", label: "All time", ms: Infinity },
];

const CONNECTION = {
  open: { color: "#22c55e", label: "Live feed connected" },
  connecting: { color: "#eab308", label: "Connecting to live feed…" },
  closed: { color: "#ef4444", label: "Live feed disconnected — retrying" },
  ended: { color: "#8b9bb3", label: "Session ended — sign in again for live updates" },
};

// ---------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------

export default function CommandCenter() {
  const { authFetch, getAccessToken } = useAuth();

  // ---- Filter state (feature: filtering by location / severity / infrastructure type / time) ----
  const [locationQuery, setLocationQuery] = useState("");
  const [severityFilter, setSeverityFilter] = useState("ALL");
  const [infraTypeFilter, setInfraTypeFilter] = useState("ALL");
  const [timeRange, setTimeRange] = useState("1h");

  // ---- Raw data state — every field here is populated ONLY from a real backend response, never a hardcoded default ----
  const [gatewayHealth, setGatewayHealth] = useState(null);
  const [serviceHealth, setServiceHealth] = useState(null);

  const [hospitalSummary, setHospitalSummary] = useState(null);
  const [hospitals, setHospitals] = useState(null);
  const [hospitalAlerts, setHospitalAlerts] = useState(null);

  const [ambulanceSummary, setAmbulanceSummary] = useState(null);
  const [ambulances, setAmbulances] = useState(null);
  const [activeEmergencies, setActiveEmergencies] = useState(null);

  const [bloodSummary, setBloodSummary] = useState(null);
  const [bloodBanks, setBloodBanks] = useState(null);
  const [bloodAlerts, setBloodAlerts] = useState(null);

  const [powerSummary, setPowerSummary] = useState(null);
  const [powerMap, setPowerMap] = useState(null);
  const [powerAlerts, setPowerAlerts] = useState(null);

  const [activeDisasters, setActiveDisasters] = useState(null);
  const [allDisasters, setAllDisasters] = useState(null);

  const [liveEvents, setLiveEvents] = useState([]);
  const [connectionStatus, setConnectionStatus] = useState("connecting");
  const [lastUpdated, setLastUpdated] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [selectedMapEntity, setSelectedMapEntity] = useState(null);

  const disconnectRef = useRef(null);
  const refetchTimerRef = useRef(null);

  // ---- Load everything in one pass. allSettled so one slow/unreachable service doesn't blank the whole dashboard. ----
  const loadAll = useCallback(async () => {
    const results = await Promise.allSettled([
      fetchGatewayHealth(),
      fetchAllServiceHealth(),
      authFetch((t) => fetchHospitalSummary(t)),
      authFetch((t) => fetchHospitals(t, { limit: 200 })),
      authFetch((t) => fetchHospitalAlerts(t)),
      authFetch((t) => fetchAmbulanceSummary(t)),
      authFetch((t) => fetchAmbulances(t, { limit: 100 })),
      authFetch((t) => fetchActiveEmergencies(t)),
      authFetch((t) => fetchBloodBankSummary(t)),
      authFetch((t) => fetchBloodBanks(t)),
      authFetch((t) => fetchShortageAlerts(t)),
      authFetch((t) => fetchPowerSummary(t)),
      authFetch((t) => fetchPowerMap(t)),
      authFetch((t) => fetchPowerAlerts(t)),
      authFetch((t) => fetchActiveDisasters(t)),
      authFetch((t) => fetchDisasters(t, { limit: 50 })),
    ]);

    const [
      gatewayRes, servicesRes,
      hospSummaryRes, hospListRes, hospAlertsRes,
      ambSummaryRes, ambListRes, ambEmergenciesRes,
      bloodSummaryRes, bloodListRes, bloodAlertsRes,
      powerSummaryRes, powerMapRes, powerAlertsRes,
      activeDisRes, allDisRes,
    ] = results;

    if (gatewayRes.status === "fulfilled") setGatewayHealth(gatewayRes.value);
    if (servicesRes.status === "fulfilled") setServiceHealth(servicesRes.value.services);
    if (hospSummaryRes.status === "fulfilled") setHospitalSummary(hospSummaryRes.value.summary);
    if (hospListRes.status === "fulfilled") setHospitals(hospListRes.value.hospitals);
    if (hospAlertsRes.status === "fulfilled") setHospitalAlerts(hospAlertsRes.value.alerts);
    if (ambSummaryRes.status === "fulfilled") setAmbulanceSummary(ambSummaryRes.value.summary);
    if (ambListRes.status === "fulfilled") setAmbulances(ambListRes.value.ambulances);
    if (ambEmergenciesRes.status === "fulfilled") setActiveEmergencies(ambEmergenciesRes.value.emergencies);
    if (bloodSummaryRes.status === "fulfilled") setBloodSummary(bloodSummaryRes.value.summary);
    if (bloodListRes.status === "fulfilled") setBloodBanks(bloodListRes.value.bloodBanks);
    if (bloodAlertsRes.status === "fulfilled") setBloodAlerts(bloodAlertsRes.value.alerts);
    if (powerSummaryRes.status === "fulfilled") setPowerSummary(powerSummaryRes.value.summary);
    if (powerMapRes.status === "fulfilled") setPowerMap(powerMapRes.value.markers);
    if (powerAlertsRes.status === "fulfilled") setPowerAlerts(powerAlertsRes.value.alerts);
    if (activeDisRes.status === "fulfilled") setActiveDisasters(activeDisRes.value.disasters);
    if (allDisRes.status === "fulfilled") setAllDisasters(allDisRes.value.disasters);

    const failures = results.filter((r) => r.status === "rejected");
    setLoadError(failures.length > 0 ? `${failures.length} of ${results.length} data sources are currently unreachable — showing what's available.` : null);
    setLastUpdated(new Date());
  }, [authFetch]);

  // Polls every 20 s while the tab is visible; a hidden tab stops polling
  // (each reload is 16 requests against the per-IP rate limit) and catches
  // up as soon as it becomes visible again.
  useEffect(() => {
    loadAll();
    const interval = setInterval(() => {
      if (!document.hidden) loadAll();
    }, 20000);
    const onVisible = () => {
      if (!document.hidden) loadAll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loadAll]);

  // ---- Feature: dashboard updates automatically when new events occur. ----
  // Bootstraps the timeline from recent history, then subscribes to the
  // same live WebSocket feed the Emergency Dashboard uses (Phase 7).
  // Any event arriving triggers both an immediate timeline append AND a
  // debounced full reload, so every section — not just the timeline —
  // reflects the new event without the person refreshing the page.
  useEffect(() => {
    authFetch((t) => fetchRecentEvents(t, 100))
      .then((res) => setLiveEvents((prev) => mergeEvents(prev, res.events || [], 200)))
      .catch(() => {});

    disconnectRef.current = connectLiveFeed({
      getToken: getAccessToken,
      onStatusChange: setConnectionStatus,
      onMessage: (frame) => {
        if (frame?.type !== "event" || !isEventEnvelope(frame.event)) return;
        setLiveEvents((prev) => mergeEvents(prev, [frame.event], 200));

        // One reload per burst: a disaster produces ~5 events within a
        // second, and every reload is 16 requests.
        if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
        refetchTimerRef.current = setTimeout(() => {
          if (!document.hidden) loadAll();
        }, 2000);
      },
    });

    return () => {
      disconnectRef.current?.();
      if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
    };
  }, [authFetch, getAccessToken, loadAll]);

  // ---------------------------------------------------------------------
  // Derived data — every value below is computed from the real state
  // above, filtered by the shared filter bar.
  // ---------------------------------------------------------------------

  const matchesLocation = useCallback(
    (text) => {
      if (!locationQuery.trim()) return true;
      return (text || "").toLowerCase().includes(locationQuery.trim().toLowerCase());
    },
    [locationQuery]
  );

  const matchesSeverity = useCallback(
    (status) => {
      if (severityFilter === "ALL") return true;
      return toTier(status) === severityFilter;
    },
    [severityFilter]
  );

  // ---- Map points, combined from every domain, filtered by all 4 filters at once ----
  const mapPoints = useMemo(() => {
    const points = [];

    (hospitals || []).forEach((h) =>
      points.push({
        id: `hosp-${h.id}`, entityType: "HOSPITAL", name: h.name, latitude: h.latitude, longitude: h.longitude,
        statusForColor: h.emergencyStatus, statusLabel: h.emergencyStatus, raw: h,
      })
    );
    (ambulances || []).forEach((a) =>
      points.push({
        id: `amb-${a.id}`, entityType: "AMBULANCE", name: a.vehicleNumber, latitude: a.latitude, longitude: a.longitude,
        statusForColor: a.status, statusLabel: a.status, raw: a,
      })
    );
    (bloodBanks || []).forEach((b) => {
      const hasCriticalAlert = (bloodAlerts || []).some((al) => al.bloodBankId === b.id && toTier(al.severity) === "CRITICAL");
      const hasWarningAlert = (bloodAlerts || []).some((al) => al.bloodBankId === b.id);
      points.push({
        id: `blood-${b.id}`, entityType: "BLOOD_BANK", name: b.name, latitude: b.latitude, longitude: b.longitude,
        statusForColor: hasCriticalAlert ? "CRITICAL" : hasWarningAlert ? "WARNING" : "NORMAL",
        statusLabel: hasCriticalAlert ? "Shortage" : hasWarningAlert ? "Low stock" : "Normal", raw: b,
      });
    });
    (powerMap || []).forEach((m) =>
      points.push({
        id: `power-${m.substationId}`, entityType: "POWER", name: m.substationName, latitude: m.latitude, longitude: m.longitude,
        statusForColor: m.worstStatus, statusLabel: m.worstStatus, raw: m,
      })
    );
    (activeDisasters || []).forEach((d) =>
      points.push({
        id: `dis-${d.id}`, entityType: "DISASTER", name: `${d.type.replace("_", " ")} (${d.severity})`, latitude: d.latitude, longitude: d.longitude,
        radiusKm: d.radiusKm, statusForColor: d.severity, statusLabel: d.status, raw: d,
      })
    );

    return points.filter((p) => matchesLocation(p.name) && matchesSeverity(p.statusForColor));
  }, [hospitals, ambulances, bloodBanks, bloodAlerts, powerMap, activeDisasters, matchesLocation, matchesSeverity]);

  const activeMapTypes = useMemo(() => {
    if (infraTypeFilter === "ALL") return new Set(["HOSPITAL", "AMBULANCE", "BLOOD_BANK", "POWER", "DISASTER"]);
    return new Set([infraTypeFilter]);
  }, [infraTypeFilter]);

  // ---- Unified alerts feed — hospital + blood-bank + power alerts, each already {severity,type,message,...} from its own service, normalized into one shape and filtered ----
  const unifiedAlerts = useMemo(() => {
    const items = [];
    (hospitalAlerts || []).forEach((a) =>
      items.push({ source: "HOSPITAL", infraType: "HOSPITAL", severity: a.severity, type: a.type, message: a.message, entityName: a.hospitalName })
    );
    (bloodAlerts || []).forEach((a) =>
      items.push({ source: "BLOOD_BANK", infraType: "BLOOD_BANK", severity: a.severity, type: a.type, message: a.message, entityName: a.bloodBankName })
    );
    (powerAlerts || []).forEach((a) =>
      items.push({ source: "POWER", infraType: "POWER", severity: a.severity, type: a.type, message: a.message, entityName: a.substationName || a.transformerCode })
    );
    (activeDisasters || []).forEach((d) =>
      items.push({ source: "DISASTER", infraType: "DISASTER", severity: d.severity, type: d.type, message: d.description, entityName: d.type.replace("_", " ") })
    );

    return items
      .filter((a) => (infraTypeFilter === "ALL" || a.infraType === infraTypeFilter) && matchesSeverity(a.severity) && matchesLocation(a.entityName + " " + a.message))
      .sort((a, b) => toTierRankDesc(a.severity, b.severity));
  }, [hospitalAlerts, bloodAlerts, powerAlerts, activeDisasters, infraTypeFilter, severityFilter, locationQuery, matchesSeverity, matchesLocation]);

  // ---- Filtered active disasters (severity + location filters apply) ----
  const filteredActiveDisasters = useMemo(() => {
    return (activeDisasters || []).filter((d) => matchesSeverity(d.severity) && matchesLocation(d.description + " " + d.type));
  }, [activeDisasters, matchesSeverity, matchesLocation]);

  // ---- Event timeline, filtered by time range (and, loosely, by the location/severity text where applicable) ----
  const filteredTimeline = useMemo(() => {
    const rangeMs = TIME_RANGES.find((r) => r.value === timeRange)?.ms ?? Infinity;
    const cutoff = Date.now() - rangeMs;
    return liveEvents
      .filter((e) => new Date(e.occurredAt).getTime() >= cutoff)
      .slice()
      .reverse();
  }, [liveEvents, timeRange]);

  // ---- Global system status banner — the worst tier across every signal we have ----
  const globalTier = useMemo(() => {
    const signals = [];
    if (gatewayHealth) signals.push(gatewayHealth.status);
    if (serviceHealth) Object.values(serviceHealth).forEach((s) => signals.push(s.status));
    (activeDisasters || []).forEach((d) => signals.push(d.severity));
    unifiedAlerts.forEach((a) => signals.push(a.severity));
    (hospitals || []).forEach((h) => signals.push(h.emergencyStatus));
    if (powerMap) powerMap.forEach((m) => signals.push(m.worstStatus));
    return signals.length > 0 ? worstTier(signals) : "NORMAL";
  }, [gatewayHealth, serviceHealth, activeDisasters, unifiedAlerts, hospitals, powerMap]);

  // ---- Chart data (all derived from real fetched state) ----

  const ambulanceChart = useMemo(() => {
    if (!ambulanceSummary) return [];
    return [
      { label: "Available", count: ambulanceSummary.available },
      { label: "Dispatched", count: ambulanceSummary.dispatched },
      { label: "En Route", count: ambulanceSummary.enRoute },
      { label: "At Scene", count: ambulanceSummary.atScene },
      { label: "Transporting", count: ambulanceSummary.transporting },
      { label: "At Hospital", count: ambulanceSummary.atHospital },
      { label: "Out of Service", count: ambulanceSummary.outOfService },
    ];
  }, [ambulanceSummary]);

  const bloodInventoryChart = useMemo(() => {
    if (!bloodSummary?.unitsByType) return [];
    return Object.entries(bloodSummary.unitsByType).map(([type, units]) => ({ type, units }));
  }, [bloodSummary]);

  const powerStatusChart = useMemo(() => {
    if (!powerSummary?.transformersByStatus) return [];
    return ["NORMAL", "WARNING", "CRITICAL", "FAILED"].map((status) => ({
      status,
      count: powerSummary.transformersByStatus[status] || 0,
    }));
  }, [powerSummary]);

  const averagePowerLoad = useMemo(() => {
    if (!powerMap) return null;
    const loads = powerMap.flatMap((m) => m.transformers.map((t) => t.loadPercentage).filter((v) => v != null));
    if (loads.length === 0) return null;
    return Math.round((loads.reduce((s, v) => s + v, 0) / loads.length) * 10) / 10;
  }, [powerMap]);

  const incidentsBySeverityChart = useMemo(() => {
    if (!allDisasters) return [];
    const counts = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
    allDisasters.forEach((d) => {
      if (counts[d.severity] !== undefined) counts[d.severity] += 1;
    });
    return Object.entries(counts).map(([severity, count]) => ({ severity, count }));
  }, [allDisasters]);

  const conn = CONNECTION[connectionStatus] || { color: "#8b9bb3", label: connectionStatus };
  const degradedServices = serviceHealth ? Object.values(serviceHealth).filter((s) => toTier(s.status) !== "NORMAL").length : null;
  const filtersActive = locationQuery || severityFilter !== "ALL" || infraTypeFilter !== "ALL";

  return (
    <section>
      {/* ---- Header + connection state ---- */}
      <PageHeader
        eyebrow="Operations"
        icon="radar"
        title={
          <>
            Command <span className="sc-grad">Center</span>
          </>
        }
        subtitle={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <LiveDot color={conn.color} live={connectionStatus === "open"} />
            <span style={{ color: conn.color }}>{conn.label}</span>
            <span style={{ color: "var(--faint)" }}>·</span>
            <span>{lastUpdated ? `Last refreshed ${lastUpdated.toLocaleTimeString()}` : "Loading…"}</span>
          </span>
        }
      />

      {loadError && <Alert tone="warn">{loadError}</Alert>}

      {/* ---- 1. Global system status ---- */}
      <div className="sc-hero sc-fade-up" style={{ "--hero-color": TIER_COLORS[globalTier] }}>
        <div className="sc-hero-status">
          <div className="sc-orb" aria-hidden="true">
            <span className="sc-orb-core" />
          </div>
          <div>
            <div className="sc-hero-kicker">System status</div>
            <div className="sc-hero-title">{tierLabel(globalTier).toUpperCase()}</div>
            <div className="sc-hero-meta">
              <span>
                <b>{activeDisasters?.length ?? "—"}</b> active disaster(s)
              </span>
              <span>
                <b>{unifiedAlerts.length}</b> alert(s)
              </span>
              <span>
                <b>{degradedServices ?? "—"}</b> service(s) degraded
              </span>
            </div>
          </div>
        </div>
        <div className="sc-hero-tiles">
          <Tile label="Hospitals" value={hospitalSummary?.totalHospitals} />
          <Tile label="Ambulances" value={ambulanceSummary?.totalAmbulances} />
          <Tile label="Blood Banks" value={bloodSummary?.totalBloodBanks} />
          <Tile label="Substations" value={powerSummary?.totalSubstations} />
        </div>
      </div>

      {/* ---- Filter bar: location / severity / infrastructure type / time ---- */}
      <div className="sc-toolbar sc-fade-up" role="search">
        <div className="sc-input-wrap">
          <Icon name="search" />
          <input
            type="text"
            placeholder="Filter by location, name, or address…"
            aria-label="Filter by location, name, or address"
            value={locationQuery}
            onChange={(e) => setLocationQuery(e.target.value)}
            className="sc-input is-sm"
            style={{ width: "100%" }}
          />
        </div>
        <select aria-label="Severity" value={severityFilter} onChange={(e) => setSeverityFilter(e.target.value)} className="sc-select is-sm">
          {SEVERITY_FILTERS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <select aria-label="Infrastructure type" value={infraTypeFilter} onChange={(e) => setInfraTypeFilter(e.target.value)} className="sc-select is-sm">
          {INFRA_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <select aria-label="Time range" value={timeRange} onChange={(e) => setTimeRange(e.target.value)} className="sc-select is-sm">
          {TIME_RANGES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        {filtersActive && (
          <button
            type="button"
            className="sc-btn is-ghost is-sm"
            onClick={() => {
              setLocationQuery("");
              setSeverityFilter("ALL");
              setInfraTypeFilter("ALL");
            }}
          >
            <Icon name="x" /> Clear
          </button>
        )}
      </div>

      <div className="sc-split" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.6fr) minmax(0, 1fr)", gap: "1.1rem", alignItems: "start" }}>
        <div className="sc-stack">
          {/* ---- 3. Interactive map ---- */}
          <Card title="Interactive Map" icon="map" subtitle="Hospitals, ambulances, blood banks, substations, and active disasters — live positions from every service.">
            {hospitals || ambulances || bloodBanks || powerMap || activeDisasters ? (
              <CommandMap points={mapPoints} activeTypes={activeMapTypes} onSelect={setSelectedMapEntity} selectedId={selectedMapEntity?.id} />
            ) : (
              <div className="sc-skel" style={{ height: 320, borderRadius: 12 }} />
            )}
            {selectedMapEntity && (
              <div className="sc-inset sc-fade-up" style={{ marginTop: "0.85rem", display: "flex", alignItems: "center", gap: 12 }}>
                <span className="sc-card-icon">
                  <Icon name={INFRA_ICONS[selectedMapEntity.entityType] || "info"} />
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <strong style={{ fontSize: "0.88rem" }}>{selectedMapEntity.name}</strong>
                    <TierBadge status={selectedMapEntity.statusForColor} small />
                  </div>
                  <div style={{ color: "var(--faint)", fontSize: "0.72rem", marginTop: 2 }}>
                    {INFRA_TYPES.find((t) => t.value === selectedMapEntity.entityType)?.label}
                  </div>
                </div>
                <button type="button" className="sc-icon-btn" onClick={() => setSelectedMapEntity(null)} aria-label="Clear selection">
                  <Icon name="x" />
                </button>
              </div>
            )}
          </Card>

          {/* ---- 2. Active disaster events ---- */}
          <Card
            title="Active Disaster Events"
            icon="flame"
            subtitle={`${filteredActiveDisasters.length} shown${activeDisasters ? ` of ${activeDisasters.length} active` : ""}`}
          >
            {!activeDisasters ? (
              <SkeletonRows />
            ) : filteredActiveDisasters.length === 0 ? (
              <Empty>No active disasters match the current filters.</Empty>
            ) : (
              <ul className="sc-list">
                {filteredActiveDisasters.map((d) => (
                  <li key={d.id}>
                    <TierBadge status={d.severity} />
                    <div className="sc-list-main">
                      <div className="sc-list-title">{d.type.replace("_", " ")}</div>
                      <div className="sc-list-meta">{d.description}</div>
                    </div>
                    <span className="sc-list-aside sc-mono">{d.radiusKm} km</span>
                  </li>
                ))}
              </ul>
            )}
            {incidentsBySeverityChart.length > 0 && (
              <div style={{ marginTop: "1.1rem" }}>
                <div className="sc-tile-label" style={{ marginBottom: 8 }}>Incidents by severity (all recorded disasters)</div>
                <BarChart data={incidentsBySeverityChart} labelKey="severity" valueKey="count" colorFor={(d) => tierColor(d.severity)} height={130} />
              </div>
            )}
          </Card>

          {/* ---- 8. Alerts ---- */}
          <Card title="Alerts" icon="bell" count={unifiedAlerts.length} subtitle="Across hospitals, blood banks, power, and disasters — worst first">
            {!hospitalAlerts && !bloodAlerts && !powerAlerts ? (
              <SkeletonRows />
            ) : unifiedAlerts.length === 0 ? (
              <Empty>No alerts match the current filters.</Empty>
            ) : (
              <ul className="sc-list is-scroll">
                {unifiedAlerts.map((a, i) => (
                  <li key={i} style={{ alignItems: "flex-start" }}>
                    <span className="sc-stat-icon" style={{ "--stat-color": tierColor(a.severity), flex: "none" }}>
                      <Icon name={INFRA_ICONS[a.infraType] || "alert"} />
                    </span>
                    <div className="sc-list-main">
                      <div className="sc-list-title">{a.message}</div>
                      <div className="sc-list-meta">
                        {INFRA_TYPES.find((t) => t.value === a.infraType)?.label} · {String(a.type).replace(/_/g, " ")}
                      </div>
                    </div>
                    <TierBadge status={a.severity} small />
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* ---- 9. Event timeline ---- */}
          <Card
            title="Event Timeline"
            icon="clock"
            subtitle={`${filteredTimeline.length} event(s) — ${TIME_RANGES.find((r) => r.value === timeRange)?.label.toLowerCase()}`}
            right={<LiveDot color={conn.color} live={connectionStatus === "open"} />}
          >
            {filteredTimeline.length === 0 ? (
              <Empty icon="clock">No events in this time range yet.</Empty>
            ) : (
              <ol className="sc-timeline" style={{ maxHeight: 340, overflowY: "auto" }}>
                {filteredTimeline.map((evt) => (
                  <li key={evt.eventId} style={{ "--tl-color": eventColor(evt.eventType) }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
                      <span style={{ fontSize: "0.82rem", color: "var(--text)" }}>{eventLabel(evt.eventType)}</span>
                      <span className="sc-mono" style={{ fontSize: "0.68rem", color: "var(--faint)", whiteSpace: "nowrap" }}>
                        {eventTime(evt)}
                      </span>
                    </div>
                    <div style={{ fontSize: "0.7rem", color: "var(--muted)", marginTop: 2 }}>{evt.sourceService}</div>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>

        <div className="sc-stack">
          {/* ---- 4. Hospitals ---- */}
          <Card title="Hospitals" icon="hospital" subtitle="Bed & ICU capacity across the network">
            {!hospitalSummary ? (
              <SkeletonRows />
            ) : (
              <>
                <div className="sc-tiles" style={{ marginBottom: "1rem" }}>
                  <Tile label="Total Beds" value={hospitalSummary.totalBeds} />
                  <Tile label="Available" value={hospitalSummary.availableBeds} color={TIER_COLORS.NORMAL} />
                  <Tile label="Overloaded" value={hospitalSummary.overloadedHospitals} color={hospitalSummary.overloadedHospitals > 0 ? TIER_COLORS.CRITICAL : undefined} />
                </div>
                <GaugeBar label="Bed occupancy" valuePct={hospitalSummary.bedOccupancyPercentage} color={tierColor(hospitalSummary.bedOccupancyPercentage > 85 ? "CRITICAL" : hospitalSummary.bedOccupancyPercentage > 70 ? "HIGH" : "NORMAL")} />
                <GaugeBar label="ICU occupancy" valuePct={hospitalSummary.icuOccupancyPercentage} color={tierColor(hospitalSummary.icuOccupancyPercentage > 85 ? "CRITICAL" : hospitalSummary.icuOccupancyPercentage > 70 ? "HIGH" : "NORMAL")} />
              </>
            )}
          </Card>

          {/* ---- 5. Ambulances ---- */}
          <Card title="Ambulances" icon="ambulance" subtitle={`Fleet availability${activeEmergencies ? ` · ${activeEmergencies.length} active emergencies` : ""}`}>
            {!ambulanceSummary ? (
              <SkeletonRows />
            ) : (
              <DonutChart
                data={ambulanceChart}
                labelKey="label"
                valueKey="count"
                centerLabel="vehicles"
                colorFor={(d) => tierColor(d.label === "Available" ? "AVAILABLE" : d.label === "Out of Service" ? "OUT_OF_SERVICE" : "DISPATCHED")}
              />
            )}
          </Card>

          {/* ---- 6. Blood banks ---- */}
          <Card title="Blood Banks" icon="droplet" subtitle={bloodSummary ? `${bloodSummary.totalUnitsAvailable} units available across ${bloodSummary.totalBloodBanks} banks` : undefined}>
            {!bloodSummary ? (
              <SkeletonRows />
            ) : (
              <>
                <BarChart data={bloodInventoryChart} labelKey="type" valueKey="units" colorFor={(d) => (d.units < 10 ? tierColor("CRITICAL") : d.units < 25 ? tierColor("WARNING") : tierColor("NORMAL"))} height={140} />
                <div className="sc-tiles" style={{ marginTop: "0.9rem" }}>
                  <Tile label="Low Stock" value={bloodSummary.lowStockCount} color={bloodSummary.lowStockCount > 0 ? TIER_COLORS.WARNING : undefined} />
                  <Tile label="Expiring Soon" value={bloodSummary.expiringSoonCount} color={bloodSummary.expiringSoonCount > 0 ? TIER_COLORS.WARNING : undefined} />
                </div>
              </>
            )}
          </Card>

          {/* ---- 7. Power infrastructure ---- */}
          <Card title="Power Infrastructure" icon="zap" subtitle={powerSummary ? `${powerSummary.totalTransformers} transformers across ${powerSummary.totalSubstations} substations` : undefined}>
            {!powerSummary ? (
              <SkeletonRows />
            ) : (
              <>
                {averagePowerLoad !== null && (
                  <GaugeBar label="Average transformer load" valuePct={averagePowerLoad} color={tierColor(averagePowerLoad > 100 ? "CRITICAL" : averagePowerLoad > 85 ? "WARNING" : "NORMAL")} />
                )}
                <BarChart data={powerStatusChart} labelKey="status" valueKey="count" colorFor={(d) => tierColor(d.status)} height={120} />
                <div className="sc-tiles" style={{ marginTop: "0.9rem" }}>
                  <Tile label="Overloaded" value={powerSummary.overloadedCount} color={powerSummary.overloadedCount > 0 ? TIER_COLORS.CRITICAL : undefined} />
                  <Tile label="High Temp" value={powerSummary.highTemperatureCount} color={powerSummary.highTemperatureCount > 0 ? TIER_COLORS.HIGH : undefined} />
                </div>
              </>
            )}
          </Card>

          {/* ---- 10. Service health ---- */}
          <Card title="Service Health" icon="server" subtitle="Gateway + every backend microservice">
            {!serviceHealth ? (
              <SkeletonRows />
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: "0.45rem" }}>
                <div className="sc-inset" style={{ display: "flex", alignItems: "center", gap: 10, gridColumn: "1 / -1", padding: "0.6rem 0.8rem" }}>
                  <LiveDot color={tierColor(gatewayHealth?.status || "unknown")} live={toTier(gatewayHealth?.status) === "NORMAL"} />
                  <span style={{ fontSize: "0.82rem", fontWeight: 600, flex: 1 }}>API Gateway</span>
                  <TierBadge status={gatewayHealth?.status || "unknown"} small />
                </div>
                {Object.entries(serviceHealth).map(([name, info]) => (
                  <div key={name} className="sc-inset" style={{ display: "flex", alignItems: "center", gap: 8, padding: "0.5rem 0.7rem" }} title={`${name}: ${info.status}`}>
                    <LiveDot color={tierColor(info.status)} live={false} />
                    <span style={{ fontSize: "0.74rem", color: "var(--text-2)", textTransform: "capitalize", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {name.replace(/-/g, " ")}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* ---- 11. Infrastructure statistics ---- */}
          <Card title="Infrastructure Statistics" icon="layers" subtitle="Network-wide totals, from each service's own summary endpoint">
            <div className="sc-tiles">
              <Tile label="Hospitals" value={hospitalSummary?.totalHospitals} />
              <Tile label="Total Beds" value={hospitalSummary?.totalBeds} />
              <Tile label="Ambulances" value={ambulanceSummary?.totalAmbulances} />
              <Tile label="Blood Banks" value={bloodSummary?.totalBloodBanks} />
              <Tile label="Blood Units" value={bloodSummary?.totalUnitsAvailable} />
              <Tile label="Substations" value={powerSummary?.totalSubstations} />
              <Tile label="Transformers" value={powerSummary?.totalTransformers} />
              <Tile label="Disasters" value={activeDisasters?.length} color={activeDisasters?.length > 0 ? TIER_COLORS.CRITICAL : undefined} />
            </div>
          </Card>
        </div>
      </div>
    </section>
  );
}

function toTierRankDesc(a, b) {
  const rank = { NORMAL: 0, WARNING: 1, HIGH: 2, CRITICAL: 3, UNKNOWN: 0 };
  const ta = toTier(a);
  const tb = toTier(b);
  return rank[tb] - rank[ta];
}
