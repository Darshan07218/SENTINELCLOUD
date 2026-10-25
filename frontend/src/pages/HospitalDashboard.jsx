import React, { useCallback, useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext.jsx";
import { fetchHospitalSummary, fetchHospitals, fetchHospitalAlerts } from "../lib/api.js";
import { settle } from "../lib/settle.js";
import { Alert, Badge, Card, Empty, Gauge, Loading, PageHeader, StatCard } from "../components/ui.jsx";
import CapacityForecast from "../components/CapacityForecast.jsx";

const STATUS_COLORS = {
  NORMAL: "#22c55e",
  ELEVATED: "#f59e0b",
  OVERLOADED: "#ef4444",
};

// Phase 21: how a hospital's bed numbers were obtained (OpenStreetMap rarely records them).
const CAPACITY_SOURCE_LABELS = {
  "osm:beds": "Beds from OpenStreetMap",
  "estimated:footprint": "Beds estimated from building footprint",
  "estimated:point": "Beds estimated (no building outline mapped)",
  "estimated:major-point": "Beds estimated (major hospital, no outline mapped)",
};

const SEVERITY_COLORS = {
  CRITICAL: "#ef4444",
  WARNING: "#f59e0b",
};

function CapacityBar({ percentage }) {
  const color = percentage >= 90 ? "#ef4444" : percentage >= 75 ? "#f59e0b" : "#22c55e";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <div className="sc-gauge-track" style={{ flex: 1, height: 6 }}>
        <div className="sc-gauge-fill" style={{ width: `${Math.min(percentage, 100)}%`, background: `linear-gradient(90deg, ${color}88, ${color})`, boxShadow: `0 0 10px ${color}77` }} />
      </div>
      <span className="sc-mono" style={{ color: "var(--muted)", fontSize: "0.74rem", minWidth: 36, textAlign: "right" }}>
        {percentage}%
      </span>
    </div>
  );
}

function Ratio({ available, total, critical }) {
  return (
    <span className="sc-mono" style={{ color: critical ? "#ef4444" : "var(--text)" }}>
      {available}
      <span style={{ color: "var(--faint)" }}> / {total}</span>
    </span>
  );
}

export default function HospitalDashboard() {
  const { authFetch } = useAuth();
  const [summary, setSummary] = useState(null);
  const [hospitals, setHospitals] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadAll = useCallback(async () => {
    const { values: v, error: loadError } = await settle({
      summary: authFetch((token) => fetchHospitalSummary(token)),
      hospitals: authFetch((token) => fetchHospitals(token, { page: 1, limit: 200 })),
      alerts: authFetch((token) => fetchHospitalAlerts(token)),
    });
    if (v.summary) setSummary(v.summary.summary);
    if (v.hospitals) setHospitals(v.hospitals.hospitals);
    if (v.alerts) setAlerts(v.alerts.alerts);
    setError(loadError);
    setLoading(false);
  }, [authFetch]);

  useEffect(() => {
    loadAll();
    const interval = setInterval(loadAll, 10000);
    return () => clearInterval(interval);
  }, [loadAll]);

  if (loading) {
    return <Loading label="Loading hospital data…" />;
  }

  if (error) {
    return <Alert>Could not load hospital data: {error}</Alert>;
  }

  return (
    <section>
      <PageHeader
        eyebrow="Infrastructure"
        icon="hospital"
        title="Hospital Intelligence"
        subtitle="Live bed, ICU and ventilator capacity across the hospital network, refreshed every 10 seconds."
      />

      {/* Summary stat cards */}
      <div className="sc-stats sc-stagger">
        <StatCard label="Total Hospitals" value={summary.totalHospitals} icon="hospital" />
        <StatCard label="Available Beds" value={summary.availableBeds} sublabel={`of ${summary.totalBeds} total`} icon="bed" color="#22c55e" />
        <StatCard
          label="ICU Available"
          value={summary.availableIcuBeds}
          sublabel={`of ${summary.totalIcuBeds} total ICU beds`}
          icon="heart"
          color={summary.availableIcuBeds === 0 ? "#ef4444" : "#818cf8"}
          accent={summary.availableIcuBeds === 0}
        />
        <StatCard
          label="Overloaded"
          value={summary.overloadedHospitals}
          icon="alert"
          color={summary.overloadedHospitals > 0 ? "#ef4444" : "#22c55e"}
          accent={summary.overloadedHospitals > 0}
        />
        <StatCard label="Bed Occupancy" value={summary.bedOccupancyPercentage} suffix="%" sublabel="occupied" icon="chart" color="#c084fc" />
      </div>

      <div className="sc-split" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 2fr)", gap: "1.1rem", alignItems: "start", marginBottom: "1.1rem" }}>
        <Card title="Network Occupancy" icon="activity" subtitle="Share of capacity currently in use">
          <Gauge
            label="Bed occupancy"
            valuePct={summary.bedOccupancyPercentage}
            color={summary.bedOccupancyPercentage >= 90 ? "#ef4444" : summary.bedOccupancyPercentage >= 75 ? "#f59e0b" : "#22c55e"}
          />
          {summary.icuOccupancyPercentage != null && (
            <Gauge
              label="ICU occupancy"
              valuePct={summary.icuOccupancyPercentage}
              color={summary.icuOccupancyPercentage >= 90 ? "#ef4444" : summary.icuOccupancyPercentage >= 75 ? "#f59e0b" : "#22c55e"}
            />
          )}
        </Card>

        {/* Capacity alerts */}
        <Card title="Capacity Alerts" icon="bell" count={alerts.length}>
          {alerts.length === 0 ? (
            <Empty>No active alerts — all hospitals within normal capacity.</Empty>
          ) : (
            <ul className="sc-list is-scroll" style={{ maxHeight: 220 }}>
              {alerts.map((alert, i) => (
                <li key={`${alert.hospitalId}-${alert.type}-${i}`}>
                  <Badge label={alert.severity} color={SEVERITY_COLORS[alert.severity] || "#64748b"} small />
                  <span className="sc-list-title">{alert.message}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* Phase 18: map coloured by forecast risk, ranking, per-hospital trend */}
      <CapacityForecast />

      {/* Hospital list */}
      <Card title="Hospital Network" icon="layers" subtitle={`${hospitals.length} facilities`} className="sc-card-flush" style={{ padding: 0 }}>
        <div className="sc-table-scroll">
          <table className="sc-table" style={{ minWidth: 760 }}>
            <thead>
              <tr>
                <th>Hospital</th>
                <th>Status</th>
                <th>Beds</th>
                <th>ICU</th>
                <th>Ventilators</th>
                <th style={{ width: 200 }}>Capacity</th>
              </tr>
            </thead>
            <tbody>
              {hospitals.map((h) => (
                <tr key={h.id}>
                  <td>
                    <div className="sc-cell-strong">{h.name}</div>
                    <div className="sc-cell-sub">{h.address}</div>
                    {h.capacitySource && <div className="sc-cell-sub" title="Phase 21: name and location from OpenStreetMap; see docs/PHASE-21-REAL-DATA.md">{CAPACITY_SOURCE_LABELS[h.capacitySource] || h.capacitySource}{h.osmId && <> · <a href={`https://www.openstreetmap.org/${h.osmId}`} target="_blank" rel="noreferrer">OSM</a></>}</div>}
                  </td>
                  <td>
                    <Badge label={h.emergencyStatus} color={STATUS_COLORS[h.emergencyStatus] || "#64748b"} />
                  </td>
                  <td>
                    <Ratio available={h.availableBeds} total={h.totalBeds} />
                  </td>
                  <td>
                    <Ratio available={h.availableIcuBeds} total={h.totalIcuBeds} critical={h.availableIcuBeds === 0} />
                  </td>
                  <td>
                    <Ratio available={h.availableVentilators} total={h.totalVentilators} critical={h.availableVentilators === 0} />
                  </td>
                  <td>
                    <CapacityBar percentage={h.capacity.beds} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </section>
  );
}
