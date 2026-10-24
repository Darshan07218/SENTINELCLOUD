import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Phase 1: dev server only needs to run inside the Compose network and
// be reachable from the host browser. No proxy config needed here since
// the frontend talks to the gateway via an absolute URL (VITE_API_BASE_URL)
// rather than a Vite dev-server proxy — this keeps behavior identical
// between `npm run dev` and the built/served production bundle.
export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    // Docker Desktop on Windows/macOS doesn't forward file-change events
    // into bind mounts, so hot reload never fires. Compose sets
    // VITE_USE_POLLING=true to make the watcher poll instead.
    watch: process.env.VITE_USE_POLLING === "true" ? { usePolling: true, interval: 300 } : undefined,
  },
});
