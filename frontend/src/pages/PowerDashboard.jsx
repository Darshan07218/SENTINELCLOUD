import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../auth/AuthContext.jsx";
import {
  fetchPowerSummary,
  fetchPowerMap,
  fetchPowerAlerts,
  fetchOverloadedTransformers,
  fetchHighTemperatureTransformers,
  fetchTransformerReadings,
} from "../lib/api.js";
import { settle, latestOnly } from "../lib/settle.js";
import { BarChart, LineChart } from "../components/MiniCharts.jsx";
import LiveMap from "../components/LiveMap.jsx";
import TransformerRiskPanel from "../components/TransformerRiskPanel.jsx";
import { Alert, Badge, Card, Empty, Loading, PageHeader, StatCard } from "../components/ui.jsx";

const STATUS_COLORS = {
  NORMAL: "#22c55e",
  WARNING: "#f59e0b",
  CRITICAL: "#f97316",
  FAILED: "#ef4444",
};

const SEVERITY_COLORS = { WARNING: "#f59e0b", CRITICAL: "#f97316", FAILED: "#ef4444" };

/**
 * Feature 8 — display infrastructure on a map: every substation at its
 * real latitude/longitude on a slippy map (components/LiveMap.jsx).
 * Pins are colored by each substation's worst-transformer status.
 */
function SubstationMap({ markers }) {
  const points = useMemo(
    () =>
      markers.map((m) => ({
        id: m.substationId,
        lat: m.latitude,
        lng: m.longitude,
        color: STATUS_COLORS[m.worstStatus] || "#94a3b8",
        shape: "square",
        pulse: Boolean(m.worstStatus) && m.worstStatus !== "NORMAL",
        label: m.substationName,
        sublabel: `${m.transformerCount} transformer(s) · worst status ${m.worstStatus}`,
      })),
    [markers]
  );

  return <LiveMap points={points} height={440} badge={`${markers.length} substations`} label="Substation map" />;
}

function Legend() {
  return (
    <div className="sc-legend">
      {Object.entries(STATUS_COLORS).map(([status, color]) => (
        <span key={status}>
          <i style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
          {status}
        </span>
      ))}
    </div>
  );
}

function ValueList({ items, render, empty }) {
  if (items.length === 0) return <Empty>{empty}</Empty>;
  return <ul className="sc-list is-scroll" style={{ maxHeight: 260 }}>{items.map(render)}</ul>;
}

export default function PowerDashboard() {
  const { authFetch } = useAuth();
  const [summary, setSummary] = useState(null);
  const [markers, setMarkers] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [overloaded, setOverloaded] = useState([]);
  const [highTemp, setHighTemp] = useState([]);
  const [selectedTransformer, setSelectedTransformer] = useState(null);
  const [readings, setReadings] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadCore = useCallback(async () => {
    const { values: v, error: loadError } = await settle({
      summary: authFetch((token) => fetchPowerSummary(token)),
      map: authFetch((token) => fetchPowerMap(token)),
      alerts: authFetch((token) => fetchPowerAlerts(token)),
      overloaded: authFetch((token) => fetchOverloadedTransformers(token)),
      highTemp: authFetch((token) => fetchHighTemperatureTransformers(token)),
    });
    if (v.summary) setSummary(v.summary.summary);
    if (v.alerts) setAlerts(v.alerts.alerts);
    if (v.overloaded) setOverloaded(v.overloaded.overloadedTransformers);
    if (v.highTemp) setHighTemp(v.highTemp.highTemperatureTransformers);
    if (v.map) {
      setMarkers(v.map.markers);
      // Default the telemetry-trend panel to the first transformer that has any readings.
      const firstWithData = v.map.markers.flatMap((m) => m.transformers).find((t) => t.loadPercentage != null);
      setSelectedTransformer((prev) => prev || firstWithData?.transformerId || null);
    }
    setError(loadError);
    setLoading(false);
  }, [authFetch]);

  // Switching transformers quickly must not let the previous one's slower
  // response replace the current chart.
  const readingRequests = useRef(latestOnly()).current;
  const loadReadings = useCallback(async () => {
    if (!selectedTransformer) return;
    const tag = readingRequests.next();
    try {
      const result = await authFetch((token) => fetchTransformerReadings(token, selectedTransformer, 30));
      if (readingRequests.isLatest(tag)) setReadings([...result.readings].reverse());
    } catch {
      if (readingRequests.isLatest(tag)) setReadings([]);
    }
  }, [authFetch, selectedTransformer, readingRequests]);

  useEffect(() => {
    loadCore();
    const interval = setInterval(loadCore, 15000);
    return () => clearInterval(interval);
  }, [loadCore]);

  useEffect(() => {
    loadReadings();
  }, [loadReadings]);

  const statusChartData = useMemo(() => {
    if (!summary) return [];
    return ["NORMAL", "WARNING", "CRITICAL", "FAILED"].map((status) => ({
      status,
      count: summary.transformersByStatus?.[status] || 0,
    }));
  }, [summary]);

  const allTransformerOptions = useMemo(
    () => markers.flatMap((m) => m.transformers.map((t) => ({ ...t, substationName: m.substationName }))),
    [markers]
  );

  if (loading) return <Loading label="Loading power infrastructure data…" />;

  if (error) {
    return <Alert>Could not load power infrastructure data: {error}</Alert>;
  }

  return (
    <section>
      <PageHeader
        eyebrow="Infrastructure"
        icon="zap"
        title="Power Infrastructure Monitoring"
        subtitle="Substations, transformer load and temperature telemetry across the grid, refreshed every 15 seconds."
      />

      <div className="sc-stats sc-stagger">
        <StatCard label="Substations" value={summary.totalSubstations} icon="server" />
        <StatCard label="Transformers" value={summary.totalTransformers} icon="cpu" color="#818cf8" />
        <StatCard label="Overloaded" value={summary.overloadedCount} icon="zap" color={summary.overloadedCount > 0 ? "#f59e0b" : "#22c55e"} accent={summary.overloadedCount > 0} />
        <StatCard label="High Temperature" value={summary.highTemperatureCount} icon="thermometer" color={summary.highTemperatureCount > 0 ? "#f97316" : "#22c55e"} accent={summary.highTemperatureCount > 0} />
        <StatCard label="Open Alerts" value={summary.openAlertsCount} icon="bell" color={summary.openAlertsCount > 0 ? "#ef4444" : "#22c55e"} accent={summary.openAlertsCount > 0} />
      </div>

      <Card
        title="Grid Map"
        icon="map"
        subtitle="Every substation at its real location. Pin color reflects each substation's worst-status transformer; hover for details."
        className="sc-section"
      >
        <SubstationMap markers={markers} />
        <Legend />
      </Card>

      {/* Phase 18: where each transformer's load and temperature are heading */}
      <TransformerRiskPanel />

      <div className="sc-grid-2 sc-section">
        <Card title="Transformers by Status" icon="chart">
          <BarChart data={statusChartData} labelKey="status" valueKey="count" colorFor={(d) => STATUS_COLORS[d.status]} height={190} />
        </Card>

        <Card
          title="Telemetry Trend"
          icon="trend"
          subtitle={readings.length > 0 ? `Load percentage over the last ${readings.length} readings` : undefined}
          right={
            <select
              aria-label="Transformer"
              value={selectedTransformer || ""}
              onChange={(e) => setSelectedTransformer(e.target.value)}
              className="sc-select is-sm"
              style={{ maxWidth: 220 }}
            >
              {allTransformerOptions.map((t) => (
                <option key={t.transformerId} value={t.transformerId}>
                  {t.code} — {t.substationName}
                </option>
              ))}
            </select>
          }
        >
          {readings.length === 0 ? (
            <Empty icon="info">No telemetry recorded for this transformer yet.</Empty>
          ) : (
            <LineChart series={[{ values: readings.map((r) => r.loadPercentage), color: "#38bdf8", label: "Load %" }]} height={190} xLabels={["oldest", "latest"]} />
          )}
        </Card>
      </div>

      <div className="sc-grid-2 sc-section">
        <Card title="Overloaded Transformers" icon="zap" count={overloaded.length}>
          <ValueList
            items={overloaded}
            empty="No overloaded transformers."
            render={(t) => (
              <li key={t.id}>
                <span className="sc-list-main sc-list-title sc-mono">{t.code}</span>
                <Badge label={`${t.lastLoadPercentage}% load`} color={t.lastLoadPercentage >= 100 ? "#ef4444" : "#f59e0b"} noDot />
              </li>
            )}
          />
        </Card>

        <Card title="High-Temperature Transformers" icon="thermometer" count={highTemp.length}>
          <ValueList
            items={highTemp}
            empty="No high-temperature transformers."
            render={(t) => (
              <li key={t.id}>
                <span className="sc-list-main sc-list-title sc-mono">{t.code}</span>
                <Badge label={`${t.lastTemperatureCelsius}°C`} color={t.lastTemperatureCelsius >= 85 ? "#ef4444" : "#f97316"} noDot />
              </li>
            )}
          />
        </Card>
      </div>

      <Card title="Infrastructure Alerts" icon="bell" count={alerts.length}>
        {alerts.length === 0 ? (
          <Empty>No active infrastructure alerts.</Empty>
        ) : (
          <ul className="sc-list is-scroll">
            {alerts.map((alert, i) => (
              <li key={i}>
                <Badge label={alert.severity} color={SEVERITY_COLORS[alert.severity] || "#64748b"} small />
                <span className="sc-list-title">{alert.message}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}
