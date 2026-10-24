import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../auth/AuthContext.jsx";
import { fetchAmbulanceSummary, fetchAmbulances, fetchActiveEmergencies } from "../lib/api.js";
import { settle } from "../lib/settle.js";
import LiveMap from "../components/LiveMap.jsx";
import { Alert, Badge, Card, Empty, Loading, PageHeader, StatCard } from "../components/ui.jsx";

const STATUS_COLORS = {
  AVAILABLE: "#22c55e",
  DISPATCHED: "#f59e0b",
  EN_ROUTE: "#3b82f6",
  AT_SCENE: "#a855f7",
  TRANSPORTING: "#ec4899",
  AT_HOSPITAL: "#64748b",
  OUT_OF_SERVICE: "#ef4444",
};

const SEVERITY_COLORS = {
  LOW: "#64748b",
  MEDIUM: "#f59e0b",
  HIGH: "#f97316",
  CRITICAL: "#ef4444",
};

/**
 * Fleet map on a real slippy map (Leaflet + OpenStreetMap/CARTO tiles,
 * see components/LiveMap.jsx): every ambulance and active emergency at
 * its real latitude/longitude, colored by status / severity.
 */
function FleetMap({ ambulances, emergencies }) {
  const points = useMemo(
    () => [
      ...emergencies.map((e) => ({
        id: `em-${e.id}`,
        lat: e.latitude,
        lng: e.longitude,
        color: SEVERITY_COLORS[e.severity] || "#ef4444",
        shape: "alert",
        pulse: true,
        label: e.description,
        sublabel: `${e.severity} · ${e.status === "ASSIGNED" ? "ambulance dispatched" : "awaiting dispatch"}`,
      })),
      ...ambulances.map((a) => ({
        id: `amb-${a.id}`,
        lat: a.latitude,
        lng: a.longitude,
        color: STATUS_COLORS[a.status] || "#94a3b8",
        shape: "circle",
        label: a.vehicleNumber,
        sublabel: `${a.status.replace(/_/g, " ")} · ${a.equipmentLevel}`,
      })),
    ],
    [ambulances, emergencies]
  );

  return <LiveMap points={points} height={460} badge={`${ambulances.length} units · ${emergencies.length} incidents`} label="Fleet map" />;
}

function Legend() {
  return (
    <div className="sc-legend">
      {Object.entries(STATUS_COLORS).map(([status, color]) => (
        <span key={status}>
          <i style={{ background: color, borderRadius: "50%", boxShadow: `0 0 6px ${color}` }} />
          {status.replace(/_/g, " ")}
        </span>
      ))}
      <span>
        <i style={{ border: "2px solid #ef4444", borderRadius: "50%", width: 11, height: 11 }} />
        Active emergency
      </span>
    </div>
  );
}

export default function AmbulanceDashboard() {
  const { authFetch } = useAuth();
  const [summary, setSummary] = useState(null);
  const [ambulances, setAmbulances] = useState([]);
  const [emergencies, setEmergencies] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadAll = useCallback(async () => {
    const { values: v, error: loadError } = await settle({
      summary: authFetch((token) => fetchAmbulanceSummary(token)),
      ambulances: authFetch((token) => fetchAmbulances(token, { page: 1, limit: 100 })),
      emergencies: authFetch((token) => fetchActiveEmergencies(token)),
    });
    if (v.summary) setSummary(v.summary.summary);
    if (v.ambulances) setAmbulances(v.ambulances.ambulances);
    if (v.emergencies) setEmergencies(v.emergencies.emergencies);
    setError(loadError);
    setLoading(false);
  }, [authFetch]);

  useEffect(() => {
    loadAll();
    const interval = setInterval(loadAll, 8000);
    return () => clearInterval(interval);
  }, [loadAll]);

  if (loading) return <Loading label="Loading fleet data…" />;

  if (error) {
    return <Alert>Could not load ambulance data: {error}</Alert>;
  }

  return (
    <section>
      <PageHeader
        eyebrow="Infrastructure"
        icon="ambulance"
        title="Ambulance & Emergency Response"
        subtitle="Fleet positions, dispatch state and open emergencies, refreshed every 8 seconds."
      />

      <div className="sc-stats sc-stagger">
        <StatCard label="Total Fleet" value={summary.totalAmbulances} icon="ambulance" />
        <StatCard label="Available" value={summary.available} color="#22c55e" accent icon="check" />
        <StatCard label="Dispatched" value={summary.dispatched} color="#f59e0b" accent icon="siren" />
        <StatCard label="En Route" value={summary.enRoute} color="#3b82f6" accent icon="arrowRight" />
        <StatCard label="At Scene" value={summary.atScene} color="#a855f7" accent icon="map" />
        <StatCard label="Transporting" value={summary.transporting} color="#ec4899" accent icon="heart" />
        <StatCard label="Out of Service" value={summary.outOfService} color="#ef4444" accent icon="x" />
        <StatCard
          label="Active Emergencies"
          value={emergencies.length}
          color={emergencies.length > 0 ? "#ef4444" : "#22c55e"}
          accent={emergencies.length > 0}
          icon="alert"
        />
      </div>

      <div className="sc-split" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.7fr) minmax(0, 1fr)", gap: "1.1rem", alignItems: "start" }}>
        <Card title="Fleet Map" icon="map" subtitle="Live positions of every unit and open emergency. Drag to pan, scroll to zoom, hover a marker for details.">
          <FleetMap ambulances={ambulances} emergencies={emergencies} />
          <Legend />
        </Card>

        <Card title="Active Emergencies" icon="siren" count={emergencies.length}>
          {emergencies.length === 0 ? (
            <Empty>No active emergencies right now.</Empty>
          ) : (
            <ul className="sc-list is-scroll" style={{ maxHeight: 520 }}>
              {emergencies.map((e) => (
                <li key={e.id} style={{ alignItems: "flex-start" }}>
                  <Badge label={e.severity} color={SEVERITY_COLORS[e.severity] || "#64748b"} small />
                  <div className="sc-list-main">
                    <div className="sc-list-title">{e.description}</div>
                    <div className="sc-list-meta" style={{ color: e.status === "ASSIGNED" ? "#60a5fa" : "#fbbf24" }}>
                      {e.status === "ASSIGNED" ? "Ambulance dispatched" : "Awaiting dispatch"}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </section>
  );
}
