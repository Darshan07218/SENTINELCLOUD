const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:8080/api/v1";
// The gateway itself (not under /api/v1) also exposes /health directly.
const GATEWAY_ROOT = API_BASE_URL.replace(/\/api\/v1\/?$/, "");

async function parseJsonSafely(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Normalized error shape for every API failure, so pages don't each
 * re-derive a message from a raw Response.
 */
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request(path, { method = "GET", body, accessToken, signal, withCookies = false } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal,
    // Phase 12: only the auth endpoints send/receive the httpOnly
    // refresh-token cookie ("include" also covers the Vite dev server,
    // which runs on another port than the gateway).
    credentials: withCookies ? "include" : "same-origin",
  });

  if (response.status === 204) return null;

  const data = await parseJsonSafely(response);
  if (!response.ok) {
    const err = data?.error || {};
    throw new ApiError(response.status, err.code || "UNKNOWN_ERROR", err.message || response.statusText, err.details);
  }
  return data;
}

// ---------------------------------------------------------------------
// System health (Phase 1, unchanged)
// ---------------------------------------------------------------------
export async function fetchGatewayHealth() {
  const res = await fetch(`${GATEWAY_ROOT}/health`);
  if (!res.ok) throw new Error(`Gateway /health returned ${res.status}`);
  return res.json();
}

export async function fetchAllServiceHealth() {
  const res = await fetch(`${GATEWAY_ROOT}/health/services`);
  if (!res.ok) throw new Error(`Gateway /health/services returned ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------
// Auth (Phase 2)
// ---------------------------------------------------------------------
// Phase 12: sign-up always creates a CITIZEN account; roles are granted by
// a SYSTEM_ADMIN on the Users page.
export function registerUser({ email, password, fullName }) {
  return request("/auth/register", { method: "POST", body: { email, password, fullName } });
}

// The refresh token never touches JavaScript: auth-service sets it as an
// httpOnly cookie on login/refresh and clears it on logout.
export function loginUser({ email, password }) {
  return request("/auth/login", { method: "POST", body: { email, password }, withCookies: true });
}

export function refreshTokens() {
  return request("/auth/refresh", { method: "POST", body: {}, withCookies: true });
}

export function logoutUser({ allDevices = false } = {}) {
  return request("/auth/logout", { method: "POST", body: { allDevices }, withCookies: true });
}

// Phase 12: user management (SYSTEM_ADMIN only — enforced by auth-service).
export function fetchUsers(accessToken, { page = 1, limit = 50 } = {}) {
  return request(`/auth/users?page=${page}&limit=${limit}`, { accessToken });
}

export function updateUser(accessToken, id, changes) {
  return request(`/auth/users/${encodeURIComponent(id)}`, { method: "PATCH", accessToken, body: changes });
}

export function fetchCurrentUser(accessToken) {
  return request("/auth/me", { accessToken });
}

// ---------------------------------------------------------------------
// Hospitals (Phase 3)
// ---------------------------------------------------------------------
export function fetchHospitalSummary(accessToken) {
  return request("/hospitals/stats/summary", { accessToken });
}

export function fetchHospitals(accessToken, { page = 1, limit = 50 } = {}) {
  return request(`/hospitals?page=${page}&limit=${limit}`, { accessToken });
}

export function fetchHospitalAlerts(accessToken) {
  return request("/hospitals/alerts", { accessToken });
}

export function fetchHospitalsWithIcuAvailable(accessToken) {
  return request("/hospitals/icu-available", { accessToken });
}

export function fetchHospitalsNear(accessToken, { lat, lng, radiusKm = 25 }) {
  return request(`/hospitals/near?lat=${lat}&lng=${lng}&radiusKm=${radiusKm}`, { accessToken });
}

// Phase 18: bed/ICU occupancy forecasts.
export function fetchHospitalForecasts(accessToken, horizonHours = 24) {
  return request(`/hospitals/forecast?horizonHours=${horizonHours}`, { accessToken });
}

export function fetchHospitalForecast(accessToken, hospitalId, horizonHours = 24) {
  return request(`/hospitals/${hospitalId}/forecast?horizonHours=${horizonHours}`, { accessToken });
}

// ---------------------------------------------------------------------
// Ambulances & Emergencies (Phase 4)
// ---------------------------------------------------------------------
export function fetchAmbulanceSummary(accessToken) {
  return request("/ambulances/stats/summary", { accessToken });
}

export function fetchAmbulances(accessToken, { page = 1, limit = 50, status } = {}) {
  const statusParam = status ? `&status=${status}` : "";
  return request(`/ambulances?page=${page}&limit=${limit}${statusParam}`, { accessToken });
}

export function fetchActiveEmergencies(accessToken) {
  return request("/ambulances/emergencies/active", { accessToken });
}

// ---------------------------------------------------------------------
// Blood Banks (Phase 5)
// ---------------------------------------------------------------------
export function fetchBloodBankSummary(accessToken) {
  return request("/blood-banks/stats/summary", { accessToken });
}

export function fetchBloodBanks(accessToken) {
  return request("/blood-banks/", { accessToken });
}

export function fetchLowStock(accessToken) {
  return request("/blood-banks/low-stock", { accessToken });
}

export function fetchExpiringSoon(accessToken, withinDays = 7) {
  return request(`/blood-banks/expiring-soon?withinDays=${withinDays}`, { accessToken });
}

export function fetchShortageAlerts(accessToken) {
  return request("/blood-banks/alerts", { accessToken });
}

export function fetchDemandForecast(accessToken, bloodType) {
  return request(`/blood-banks/forecast?bloodType=${encodeURIComponent(bloodType)}`, { accessToken });
}

// ---------------------------------------------------------------------
// Power Infrastructure (Phase 6)
// ---------------------------------------------------------------------
export function fetchPowerSummary(accessToken) {
  return request("/power/stats/summary", { accessToken });
}

export function fetchSubstations(accessToken) {
  return request("/power/", { accessToken });
}

export function fetchTransformersForSubstation(accessToken, substationId) {
  return request(`/power/${substationId}/transformers`, { accessToken });
}

export function fetchPowerMap(accessToken) {
  return request("/power/map", { accessToken });
}

export function fetchPowerAlerts(accessToken) {
  return request("/power/alerts", { accessToken });
}

export function fetchOverloadedTransformers(accessToken) {
  return request("/power/transformers/overloaded", { accessToken });
}

export function fetchHighTemperatureTransformers(accessToken) {
  return request("/power/transformers/high-temperature", { accessToken });
}

export function fetchTransformerReadings(accessToken, transformerId, limit = 50) {
  return request(`/power/transformers/${transformerId}/readings?limit=${limit}`, { accessToken });
}

export function fetchTransformerAnomalies(accessToken, transformerId) {
  return request(`/power/transformers/${transformerId}/anomalies`, { accessToken });
}

// Phase 18: transformer-risk forecasts (the fleet list carries each projection).
export function fetchTransformerRisks(accessToken, horizonHours = 24) {
  return request(`/power/transformers/risk-forecast?horizonHours=${horizonHours}`, { accessToken });
}

export function fetchTransformerRisk(accessToken, transformerId, horizonHours = 24) {
  return request(`/power/transformers/${transformerId}/risk-forecast?horizonHours=${horizonHours}`, { accessToken });
}

export function fetchTransformerFailureHistory(accessToken, transformerId) {
  return request(`/power/transformers/${transformerId}/failures`, { accessToken });
}

export function recordTransformerTelemetry(accessToken, transformerId, { voltage, currentAmps, loadPercentage, temperatureCelsius }) {
  return request(`/power/transformers/${transformerId}/telemetry`, {
    method: "POST",
    accessToken,
    body: { voltage, currentAmps, loadPercentage, temperatureCelsius },
  });
}

export { request as authenticatedRequest };

// ---------------------------------------------------------------------
// Disaster/Event Intelligence + live feed (Phase 7)
// ---------------------------------------------------------------------

/** ws:// (or wss:// if the gateway is https) URL for the live event feed — see services/gateway/src/index.js's /ws/live proxy to notification-service. */
export function getLiveFeedUrl() {
  // Phase 9: in Kubernetes the frontend is served by nginx on the SAME
  // origin as the API (nginx proxies /api, /ws and /health to the
  // gateway Service), so VITE_API_BASE_URL is the relative "/api/v1"
  // and GATEWAY_ROOT is "". Resolve against the page's own origin so
  // the WebSocket URL is absolute (ws://host/ws/live, or wss:// behind
  // HTTPS) — older browsers reject relative URLs in new WebSocket().
  const root = GATEWAY_ROOT || window.location.origin;
  return root.replace(/^http/, "ws") + "/ws/live";
}

export function fetchRecentEvents(accessToken, limit = 50) {
  return request(`/notifications/events/recent?limit=${limit}`, { accessToken });
}

export function createDisaster(accessToken, disaster) {
  return request("/disasters", { method: "POST", accessToken, body: disaster });
}

export function fetchDisasters(accessToken, { page = 1, limit = 20, status, type } = {}) {
  const params = new URLSearchParams({ page, limit });
  if (status) params.set("status", status);
  if (type) params.set("type", type);
  return request(`/disasters?${params.toString()}`, { accessToken });
}

export function fetchActiveDisasters(accessToken) {
  return request("/disasters/active", { accessToken });
}

export function fetchDisaster(accessToken, id) {
  return request(`/disasters/${id}`, { accessToken });
}

export function updateDisasterStatus(accessToken, id, status, note) {
  return request(`/disasters/${id}/status`, { method: "POST", accessToken, body: { status, note } });
}

export function fetchSituationReport(accessToken, id) {
  return request(`/disasters/${id}/situation-report`, { accessToken });
}

// ---------------------------------------------------------------------
// Response plans (Phase 15) — response-service via the gateway. Reads need
// any valid login; approve/reject/undo need EMERGENCY_OPERATOR or
// SYSTEM_ADMIN (enforced by the gateway and again by response-service).
// ---------------------------------------------------------------------
export function fetchResponsePlans(accessToken, disasterId) {
  return request(`/response/plans?disasterId=${encodeURIComponent(disasterId)}`, { accessToken });
}

/** decision: "approve" | "reject" | "undo" */
export function decideResponsePlan(accessToken, planId, decision, note) {
  return request(`/response/plans/${planId}/${decision}`, { method: "POST", accessToken, body: note ? { note } : {} });
}

// ---------------------------------------------------------------------
// Resilience Demo (Phase 11) — resilience-service via the gateway.
// Reads need any valid login; starting/aborting a drill needs SYSTEM_ADMIN
// (enforced by the gateway and again by resilience-service).
// ---------------------------------------------------------------------
export function fetchResilienceScenarios(accessToken) {
  return request("/resilience/scenarios", { accessToken });
}

export function fetchResilienceOverview(accessToken) {
  return request("/resilience/overview", { accessToken });
}

export function fetchResilienceRun(accessToken) {
  return request("/resilience/runs/current", { accessToken });
}

export function startResilienceDrill(accessToken, scenarioId) {
  return request("/resilience/runs", { method: "POST", accessToken, body: { scenarioId } });
}

export function abortResilienceDrill(accessToken) {
  return request("/resilience/runs/current/abort", { method: "POST", accessToken });
}

// ---------------------------------------------------------------------
// Scenario simulator (Phase 16) — simulator-service via the gateway.
// Reads need any valid login; starting/stopping and background mode need
// SYSTEM_ADMIN (enforced by the gateway and again by simulator-service).
// ---------------------------------------------------------------------
export function fetchSimulatorScenarios(accessToken) {
  return request("/simulator/scenarios", { accessToken });
}

export function fetchSimulatorStatus(accessToken) {
  return request("/simulator/status", { accessToken });
}

export function startSimulatorScenario(accessToken, scenarioId) {
  return request("/simulator/runs", { method: "POST", accessToken, body: { scenarioId } });
}

export function stopSimulatorScenario(accessToken) {
  return request("/simulator/runs/current/stop", { method: "POST", accessToken });
}

export function setSimulatorAmbient(accessToken, enabled) {
  return request("/simulator/ambient", { method: "POST", accessToken, body: { enabled } });
}

// ---------------------------------------------------------------------
// Automatic disaster detection (Phase 19) — intake-service via the gateway.
// Reading: any signed-in user. Confirm / dismiss / poll: EMERGENCY_OPERATOR
// or SYSTEM_ADMIN. Demo detections: SYSTEM_ADMIN.
// ---------------------------------------------------------------------
export function fetchIntakeOverview(accessToken) {
  return request("/intake/overview", { accessToken });
}

export function fetchDetections(accessToken, { status, limit = 50 } = {}) {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (status) qs.set("status", status);
  return request(`/intake/detections?${qs}`, { accessToken });
}

export function confirmDetection(accessToken, id, note) {
  return request(`/intake/detections/${id}/confirm`, { method: "POST", accessToken, body: note ? { note } : {} });
}

export function dismissDetection(accessToken, id, note) {
  return request(`/intake/detections/${id}/dismiss`, { method: "POST", accessToken, body: note ? { note } : {} });
}

export function pollIntakeSources(accessToken) {
  return request("/intake/poll", { method: "POST", accessToken });
}

export function injectDemoDetection(accessToken, { type, severity }) {
  return request("/intake/demo", { method: "POST", accessToken, body: { type, severity } });
}
