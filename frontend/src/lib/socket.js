import { getLiveFeedUrl } from "./api.js";

/**
 * Minimal auto-reconnecting WebSocket client for the live emergency
 * feed (notification-service's /ws/live, proxied through the gateway
 * — see services/gateway/src/index.js). Deliberately not a generic
 * pub/sub library: this project has exactly one live feed, so this
 * stays a small wrapper rather than an abstraction for feeds that
 * don't exist yet.
 *
 * Phase 12: the feed requires a logged-in user. `getToken` returns a
 * current access token (AuthContext.getAccessToken); it is sent as the
 * WebSocket sub-protocol "bearer.<token>" next to the app protocol
 * "sentinel-live" — browsers can't set an Authorization header on a
 * WebSocket, and a token in the URL would end up in access logs. A fresh
 * token is fetched for every (re)connect.
 *
 * onMessage receives the raw parsed frame — { type: "welcome" | "heartbeat" | "event", ... }
 * (see notification-service/src/index.js for the frame shapes this
 * emits). onStatusChange receives "connecting" | "open" | "closed"
 * (dropped, retrying) | "ended" (no session any more, not retrying).
 */
export function connectLiveFeed({ getToken, onMessage, onStatusChange }) {
  let socket = null;
  let reconnectTimer = null;
  let closedByCaller = false;
  let attempt = 0;

  async function connect() {
    onStatusChange?.("connecting");
    let token;
    try {
      token = await getToken();
    } catch {
      token = null;
    }
    if (closedByCaller) return;
    if (!token) {
      // No session any more (logged out / refresh failed): stop retrying.
      // The page reconnects when it mounts again after the next login.
      onStatusChange?.("ended");
      return;
    }
    socket = new WebSocket(getLiveFeedUrl(), ["sentinel-live", `bearer.${token}`]);

    socket.onopen = () => {
      attempt = 0;
      onStatusChange?.("open");
    };

    socket.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data);
        if (frame && typeof frame === "object") onMessage?.(frame);
      } catch (err) {
        console.error("[live feed] failed to parse message:", err);
      }
    };

    socket.onclose = () => {
      onStatusChange?.("closed");
      scheduleReconnect();
    };

    socket.onerror = () => {
      socket?.close();
    };
  }

  // Exponential backoff capped at 10s, so a notification-service restart
  // (or a laptop waking from sleep) doesn't hammer the gateway.
  function scheduleReconnect() {
    if (closedByCaller) return;
    const delay = Math.min(1000 * 2 ** attempt, 10000);
    attempt += 1;
    reconnectTimer = setTimeout(connect, delay);
  }

  connect();

  return function disconnect() {
    closedByCaller = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.close();
  };
}
