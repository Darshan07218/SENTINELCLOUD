import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../auth/AuthContext.jsx";
import {
  fetchBloodBankSummary,
  fetchLowStock,
  fetchExpiringSoon,
  fetchShortageAlerts,
  fetchDemandForecast,
} from "../lib/api.js";
import { settle, latestOnly } from "../lib/settle.js";
import { BarChart, LineChart } from "../components/MiniCharts.jsx";
import { Alert, Badge, Card, Empty, Loading, PageHeader, StatCard } from "../components/ui.jsx";

const BLOOD_TYPES = ["O+", "O-", "A+", "A-", "B+", "B-", "AB+", "AB-"];

const SEVERITY_COLORS = { CRITICAL: "#ef4444", WARNING: "#f59e0b" };

export default function BloodBankDashboard() {
  const { authFetch } = useAuth();
  const [summary, setSummary] = useState(null);
  const [lowStock, setLowStock] = useState([]);
  const [expiringSoon, setExpiringSoon] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [forecastType, setForecastType] = useState("O+");
  const [forecast, setForecast] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadCore = useCallback(async () => {
    const { values: v, error: loadError } = await settle({
      summary: authFetch((token) => fetchBloodBankSummary(token)),
      lowStock: authFetch((token) => fetchLowStock(token)),
      expiring: authFetch((token) => fetchExpiringSoon(token, 7)),
      alerts: authFetch((token) => fetchShortageAlerts(token)),
    });
    if (v.summary) setSummary(v.summary.summary);
    if (v.lowStock) setLowStock(v.lowStock.lowStock);
    if (v.expiring) setExpiringSoon(v.expiring.expiringSoon);
    if (v.alerts) setAlerts(v.alerts.alerts);
    setError(loadError);
    setLoading(false);
  }, [authFetch]);

  // Switching blood type quickly must not let the previous type's slower
  // response replace the current one.
  const forecastRequests = useRef(latestOnly()).current;
  const loadForecast = useCallback(async () => {
    const tag = forecastRequests.next();
    try {
      const result = await authFetch((token) => fetchDemandForecast(token, forecastType));
      if (forecastRequests.isLatest(tag)) setForecast(result);
    } catch {
      if (forecastRequests.isLatest(tag)) setForecast(null);
    }
  }, [authFetch, forecastType, forecastRequests]);

  useEffect(() => {
    loadCore();
    const interval = setInterval(loadCore, 15000);
    return () => clearInterval(interval);
  }, [loadCore]);

  useEffect(() => {
    loadForecast();
  }, [loadForecast]);

  const inventoryChartData = useMemo(() => {
    if (!summary) return [];
    return BLOOD_TYPES.map((type) => ({ type, units: summary.unitsByType?.[type] || 0 }));
  }, [summary]);

  // Historical demand as one series; the forecast as a dashed segment from
  // the last historical point to the predicted next period.
  const forecastSeries = useMemo(() => {
    if (!forecast) return null;
    const hist = forecast.historicalDemand.map((p) => p.unitsRequested);
    const series = [{ values: hist, color: "#38bdf8", label: "Historical demand" }];
    if (forecast.predictedNextPeriodUnits != null && hist.length > 0) {
      series.push({
        values: [hist[hist.length - 1], forecast.predictedNextPeriodUnits],
        offset: hist.length - 1,
        color: "#f59e0b",
        dashed: true,
        emphasize: true,
        label: "Forecast",
      });
    }
    return series;
  }, [forecast]);

  if (loading) return <Loading label="Loading blood bank data…" />;

  if (error) {
    return <Alert>Could not load blood bank data: {error}</Alert>;
  }

  return (
    <section>
      <PageHeader
        eyebrow="Infrastructure"
        icon="droplet"
        title="Blood Bank Intelligence"
        subtitle="Inventory by blood type, shortages, expiring batches and a prototype demand forecast."
      />

      <div className="sc-stats sc-stagger">
        <StatCard label="Blood Banks" value={summary.totalBloodBanks} icon="droplet" color="#f43f5e" />
        <StatCard label="Units Available" value={summary.totalUnitsAvailable} icon="layers" color="#38bdf8" />
        <StatCard label="Low-Stock Types" value={summary.lowStockCount} icon="alert" color={summary.lowStockCount > 0 ? "#f59e0b" : "#22c55e"} accent={summary.lowStockCount > 0} />
        <StatCard label="Expiring Soon" value={summary.expiringSoonCount} icon="clock" color={summary.expiringSoonCount > 0 ? "#ef4444" : "#22c55e"} accent={summary.expiringSoonCount > 0} />
      </div>

      <div className="sc-split sc-section" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: "1.1rem", alignItems: "stretch" }}>
        <Card title="Current Inventory by Blood Type" icon="chart">
          <BarChart
            data={inventoryChartData}
            labelKey="type"
            valueKey="units"
            colorFor={(d) => (d.units < 10 ? "#ef4444" : d.units < 25 ? "#f59e0b" : "#f43f5e")}
            height={210}
          />
        </Card>

        <Card
          title="Demand Trend & Forecast"
          icon="trend"
          right={
            <select aria-label="Blood type" value={forecastType} onChange={(e) => setForecastType(e.target.value)} className="sc-select is-sm">
              {BLOOD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          }
        >
          {forecast && forecastSeries ? (
            <>
              <LineChart series={forecastSeries} height={170} />
              <div className="sc-legend">
                <span>
                  <i style={{ background: "#38bdf8" }} /> Historical demand
                </span>
                <span>
                  <i style={{ background: "#f59e0b" }} /> Predicted next period:{" "}
                  <b className="sc-mono" style={{ color: "var(--text)" }}>{forecast.predictedNextPeriodUnits ?? "N/A"}</b> units
                </span>
              </div>
              <div style={{ marginTop: "0.85rem" }}>
                <Alert tone="warn" role="note">{forecast.disclaimer}</Alert>
              </div>
            </>
          ) : (
            <Empty icon="info">No forecast available for {forecastType}.</Empty>
          )}
        </Card>
      </div>

      <div className="sc-grid-2 sc-section">
        <Card title="Low-Stock Groups" icon="alert" count={lowStock.length}>
          {lowStock.length === 0 ? (
            <Empty>No blood types are currently low on stock.</Empty>
          ) : (
            <ul className="sc-list is-scroll" style={{ maxHeight: 260 }}>
              {lowStock.map((entry, i) => (
                <li key={i}>
                  <span className="sc-badge no-dot" style={{ "--badge-color": "#f43f5e", fontFamily: "var(--mono)" }}>{entry.bloodType}</span>
                  <span className="sc-list-main" />
                  <Badge label={`${entry.unitsAvailable} units`} color={entry.unitsAvailable <= 2 ? "#ef4444" : "#f59e0b"} noDot />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Expiring Within 7 Days" icon="clock" count={expiringSoon.length}>
          {expiringSoon.length === 0 ? (
            <Empty>No units expiring soon.</Empty>
          ) : (
            <ul className="sc-list is-scroll" style={{ maxHeight: 260 }}>
              {expiringSoon.map((batch) => (
                <li key={batch.id}>
                  <span className="sc-badge no-dot" style={{ "--badge-color": "#f43f5e", fontFamily: "var(--mono)" }}>{batch.bloodType}</span>
                  <span className="sc-list-main sc-list-title">{batch.unitsAvailable} units</span>
                  <span className="sc-list-aside" style={{ color: "#fbbf24" }}>exp. {batch.expiryDate}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Shortage Alerts" icon="bell" count={alerts.length}>
        {alerts.length === 0 ? (
          <Empty>No active shortage alerts.</Empty>
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
