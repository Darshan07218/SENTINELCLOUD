import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../auth/AuthContext.jsx";
import { fetchTransformerRisks } from "../lib/api.js";
import { tierColor } from "../lib/statusTier.js";
import { LineChart } from "./MiniCharts.jsx";
import { Alert, Badge, Card, Empty } from "./ui.jsx";

const HORIZON_HOURS = 24;

function etaText(risk) {
  const f = risk.forecast;
  const hours = [f.load?.hoursToCritical, f.temperature?.hoursToCritical].filter((h) => h != null);
  if (hours.length === 0) return `not within ${HORIZON_HOURS} h`;
  const soonest = Math.min(...hours);
  return soonest === 0 ? "now" : `~${soonest} h`;
}

function ScoreBar({ score, color }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div className="sc-gauge-track" style={{ flex: 1, height: 6, minWidth: 60 }}>
        <div className="sc-gauge-fill" style={{ width: `${score}%`, background: `linear-gradient(90deg, ${color}88, ${color})` }} />
      </div>
      <span className="sc-mono" style={{ color: "var(--muted)", fontSize: "0.74rem", minWidth: 26, textAlign: "right" }}>
        {score}
      </span>
    </div>
  );
}

/**
 * Phase 18: transformer-risk forecast — every transformer ranked by a
 * 0–100 risk score, and the selected one's load/temperature projection
 * against its CRITICAL lines, with the reasons. One request
 * (GET /power/transformers/risk-forecast) carries every projection.
 * Method: power-service TransformerRiskForecaster.
 */
export default function TransformerRiskPanel() {
  const { authFetch } = useAuth();
  const [risks, setRisks] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const result = await authFetch((token) => fetchTransformerRisks(token, HORIZON_HOURS));
      setRisks(result.risks);
      setSelectedId((prev) => prev || result.risks[0]?.transformerId || null);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [authFetch]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, [load]);

  const selected = risks.find((r) => r.transformerId === selectedId) || null;

  const chart = useMemo(() => {
    const p = selected?.forecast.projection || [];
    if (p.length === 0) return null;
    return [
      { values: p.map((x) => x.loadPercentage), color: "#38bdf8", label: "Load %", hideDots: true },
      { values: p.map((x) => x.temperatureCelsius), color: "#f97316", label: "Temperature °C", hideDots: true },
      { values: p.map(() => selected.forecast.load.criticalLevel), color: "rgba(56,189,248,0.5)", dashed: true, label: "Load critical", hideDots: true },
      { values: p.map(() => selected.forecast.temperature.criticalLevel), color: "rgba(239,68,68,0.6)", dashed: true, label: "Temperature critical", hideDots: true },
    ];
  }, [selected]);

  if (error && risks.length === 0) return <Alert>Could not load transformer risk forecasts: {error}</Alert>;

  return (
    <div className="sc-split sc-section" style={{ display: "grid", gridTemplateColumns: "minmax(0, 3fr) minmax(0, 2fr)", gap: "1.1rem", alignItems: "start" }}>
      <Card
        title={`Transformer Risk — next ${HORIZON_HOURS} h`}
        icon="trend"
        subtitle="Score 0–100 from projected temperature and load, recent failures and anomalous readings."
        count={risks.length}
        className="sc-card-flush"
        style={{ padding: 0 }}
      >
        {risks.length === 0 ? (
          <Empty icon="info">No transformers to forecast.</Empty>
        ) : (
          <div className="sc-table-scroll">
            <table className="sc-table" style={{ minWidth: 640 }}>
              <thead>
                <tr>
                  <th>Transformer</th>
                  <th>Risk</th>
                  <th style={{ width: 130 }}>Score</th>
                  <th>Temp now → {HORIZON_HOURS} h</th>
                  <th>Load now → {HORIZON_HOURS} h</th>
                  <th>Critical in</th>
                </tr>
              </thead>
              <tbody>
                {risks.map((r) => {
                  const f = r.forecast;
                  const color = tierColor(f.level);
                  return (
                    <tr key={r.transformerId} className={r.transformerId === selectedId ? "is-selected" : undefined}>
                      <td>
                        <button type="button" className="sc-row-btn" onClick={() => setSelectedId(r.transformerId)} aria-pressed={r.transformerId === selectedId}>
                          <div className="sc-cell-strong sc-mono">{r.code}</div>
                          <div className="sc-cell-sub">{r.substationName}</div>
                        </button>
                      </td>
                      <td>
                        <Badge label={f.level} color={color} small />
                      </td>
                      <td>
                        <ScoreBar score={f.score} color={color} />
                      </td>
                      <td className="sc-mono">{f.temperature ? `${f.temperature.current} → ${f.temperature.projected} °C` : "—"}</td>
                      <td className="sc-mono">{f.load ? `${f.load.current} → ${f.load.projected} %` : "—"}</td>
                      <td className="sc-mono">{f.load ? etaText(r) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title={selected ? `${selected.code} projection` : "Projection"} icon="activity" subtitle={selected ? `${selected.name} · ${selected.substationName}` : undefined}>
        {!selected ? (
          <Empty icon="info">Select a transformer.</Empty>
        ) : (
          <>
            {chart ? (
              <>
                <LineChart series={chart} height={170} xLabels={["now", `+${HORIZON_HOURS / 2} h`, `+${HORIZON_HOURS} h`]} />
                <div className="sc-legend">
                  <span>
                    <i style={{ background: "#38bdf8" }} /> Load % (dashed: {selected.forecast.load.criticalLevel}% critical)
                  </span>
                  <span>
                    <i style={{ background: "#f97316" }} /> Temperature °C (dashed red: {selected.forecast.temperature.criticalLevel} °C critical)
                  </span>
                </div>
              </>
            ) : (
              <Empty icon="info">No telemetry yet, so there is nothing to project.</Empty>
            )}
            <ul className="sc-reasons">
              {selected.forecast.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
              <li>
                {selected.forecast.readingsUsed} reading(s) over {selected.forecast.historyHours} h; trend projected no further ahead than that.
              </li>
            </ul>
          </>
        )}
      </Card>
    </div>
  );
}
