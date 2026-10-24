import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../auth/AuthContext.jsx";
import { fetchHospitalForecast, fetchHospitalForecasts } from "../lib/api.js";
import { latestOnly } from "../lib/settle.js";
import { tierColor } from "../lib/statusTier.js";
import { LineChart } from "./MiniCharts.jsx";
import LiveMap from "./LiveMap.jsx";
import { Alert, Badge, Card, Empty } from "./ui.jsx";

const HORIZON_HOURS = 24;
const CHART_HISTORY_HOURS = 48;

/** "now", "~7 h" or "not within 24 h" for hoursToThreshold. */
function eta(hours) {
  if (hours == null) return `not within ${HORIZON_HOURS} h`;
  if (hours === 0) return "now";
  return `~${hours} h`;
}

function Arrow({ from, to }) {
  const up = to > from + 0.05;
  const down = to < from - 0.05;
  return (
    <span className="sc-mono">
      {from}% <span style={{ color: up ? "#f97316" : down ? "#22c55e" : "var(--faint)" }}>{up ? "↗" : down ? "↘" : "→"}</span> {to}%
    </span>
  );
}

/**
 * Phase 18: bed/ICU occupancy forecast for the hospital network — a map
 * coloured by forecast risk, a ranking, and one hospital's history with
 * its forecast and 80% band. Data: GET /hospitals/forecast (ranking) and
 * GET /hospitals/:id/forecast (series). See hospital-service
 * src/services/forecast.js for the method.
 */
export default function CapacityForecast() {
  const { authFetch } = useAuth();
  const [forecasts, setForecasts] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);

  const loadList = useCallback(async () => {
    try {
      const result = await authFetch((token) => fetchHospitalForecasts(token, HORIZON_HOURS));
      setForecasts(result.forecasts);
      setSelectedId((prev) => prev || result.forecasts[0]?.hospitalId || null);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [authFetch]);

  const detailRequests = useRef(latestOnly()).current;
  const loadDetail = useCallback(async () => {
    if (!selectedId) return;
    const tag = detailRequests.next();
    try {
      const result = await authFetch((token) => fetchHospitalForecast(token, selectedId, HORIZON_HOURS));
      if (detailRequests.isLatest(tag)) setDetail(result.forecast);
    } catch {
      if (detailRequests.isLatest(tag)) setDetail(null);
    }
  }, [authFetch, selectedId, detailRequests]);

  useEffect(() => {
    loadList();
    const interval = setInterval(loadList, 30000);
    return () => clearInterval(interval);
  }, [loadList]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail, forecasts]);

  const points = useMemo(
    () =>
      forecasts.map((f) => ({
        id: f.hospitalId,
        lat: f.latitude,
        lng: f.longitude,
        color: tierColor(f.risk),
        shape: "circle",
        pulse: f.risk === "HIGH" || f.risk === "CRITICAL",
        label: f.hospitalName,
        sublabel: `Beds ${f.beds.currentPct}% → ${f.beds.predictedPct}% in ${HORIZON_HOURS} h · ${f.risk}`,
      })),
    [forecasts]
  );

  const chart = useMemo(() => {
    if (!detail || detail.beds.forecast.length === 0) return null;
    const hist = detail.beds.history.slice(-CHART_HISTORY_HOURS).map((p) => p.pct);
    const last = hist.length - 1;
    const tail = (key) => [hist[last], ...detail.beds.forecast.map((p) => p[key])];
    return [
      { values: hist, color: "#38bdf8", label: "Occupancy %", hideDots: true },
      { values: tail("high"), offset: last, color: "rgba(249,115,22,0.45)", dashed: true, label: "80% band (high)", hideDots: true },
      { values: tail("low"), offset: last, color: "rgba(249,115,22,0.45)", dashed: true, label: "80% band (low)", hideDots: true },
      { values: tail("pct"), offset: last, color: "#f97316", dashed: true, label: "Forecast %", hideDots: true },
      { values: Array(hist.length + HORIZON_HOURS).fill(detail.beds.thresholdPct), color: "rgba(239,68,68,0.55)", dashed: true, label: "Full (90%)", hideDots: true },
    ];
  }, [detail]);

  if (error && forecasts.length === 0) return <Alert>Could not load capacity forecasts: {error}</Alert>;

  return (
    <>
      <Card
        title={`Capacity Forecast — next ${HORIZON_HOURS} h`}
        icon="trend"
        subtitle="Every hospital coloured by forecast risk (bed or ICU occupancy heading for the 90% line). Click a hospital for its trend."
        className="sc-section"
      >
        <LiveMap
          points={points}
          height={380}
          badge={`${forecasts.length} hospitals`}
          selectedId={selectedId}
          onSelect={(p) => setSelectedId(p.id)}
          label="Hospital forecast risk map"
        />
        <div className="sc-legend">
          {["LOW", "MODERATE", "HIGH", "CRITICAL"].map((r) => (
            <span key={r}>
              <i style={{ background: tierColor(r), boxShadow: `0 0 6px ${tierColor(r)}` }} />
              {r}
            </span>
          ))}
        </div>
      </Card>

      <div className="sc-split sc-section" style={{ display: "grid", gridTemplateColumns: "minmax(0, 3fr) minmax(0, 2fr)", gap: "1.1rem", alignItems: "start" }}>
        <Card title="Forecast Ranking" icon="layers" count={forecasts.length} className="sc-card-flush" style={{ padding: 0 }}>
          {forecasts.length === 0 ? (
            <Empty icon="info">No hospitals to forecast.</Empty>
          ) : (
            <div className="sc-table-scroll">
              <table className="sc-table" style={{ minWidth: 620 }}>
                <thead>
                  <tr>
                    <th>Hospital</th>
                    <th>Risk</th>
                    <th>Beds now → {HORIZON_HOURS} h</th>
                    <th>90% line</th>
                    <th>ICU now → {HORIZON_HOURS} h</th>
                  </tr>
                </thead>
                <tbody>
                  {forecasts.map((f) => (
                    <tr key={f.hospitalId} className={f.hospitalId === selectedId ? "is-selected" : undefined}>
                      <td>
                        <button type="button" className="sc-row-btn sc-cell-strong" onClick={() => setSelectedId(f.hospitalId)} aria-pressed={f.hospitalId === selectedId}>
                          {f.hospitalName}
                        </button>
                      </td>
                      <td>
                        <Badge label={f.risk} color={tierColor(f.risk)} small />
                      </td>
                      <td>
                        <Arrow from={f.beds.currentPct} to={f.beds.predictedPct} />
                      </td>
                      <td className="sc-mono">{eta(f.beds.hoursToThreshold)}</td>
                      <td>
                        <Arrow from={f.icu.currentPct} to={f.icu.predictedPct} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title={detail ? detail.hospitalName : "Hospital trend"} icon="activity" subtitle={detail ? `Bed occupancy, last ${CHART_HISTORY_HOURS} h and next ${HORIZON_HOURS} h` : undefined}>
          {!detail ? (
            <Empty icon="info">Select a hospital.</Empty>
          ) : detail.beds.status !== "OK" || !chart ? (
            <Empty icon="info">Not enough history for a forecast yet: current bed occupancy is {detail.beds.currentPct}%.</Empty>
          ) : (
            <>
              <LineChart series={chart} height={180} xLabels={[`−${CHART_HISTORY_HOURS} h`, "now", `+${HORIZON_HOURS} h`]} />
              <div className="sc-legend">
                <span>
                  <i style={{ background: "#38bdf8" }} /> Recorded
                </span>
                <span>
                  <i style={{ background: "#f97316" }} /> Forecast (dashed band: 80%)
                </span>
                <span>
                  <i style={{ background: "#ef4444" }} /> Full line
                </span>
              </div>
              <ul className="sc-reasons">
                <li>
                  Beds: {detail.beds.currentPct}% now, trend {detail.beds.trendPctPerHour > 0 ? "+" : ""}
                  {detail.beds.trendPctPerHour}% per hour, {detail.beds.predictedPct}% in {HORIZON_HOURS} h; 90% line: {eta(detail.beds.hoursToThreshold)}.
                </li>
                <li>
                  ICU: {detail.icu.currentPct}% now, {detail.icu.predictedPct}% in {HORIZON_HOURS} h; 90% line: {eta(detail.icu.hoursToThreshold)}.
                </li>
                <li>
                  Based on {detail.historyPoints} recorded change(s)
                  {detail.backfilledPoints > 0 ? `, ${detail.backfilledPoints} of them synthetic demo history` : ""}. {detail.method}.
                </li>
              </ul>
            </>
          )}
        </Card>
      </div>
    </>
  );
}
