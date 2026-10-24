import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
// Self-hosted variable fonts: bundled into the build and served from this
// origin, so the CSP's font-src 'self' keeps working (no font CDN).
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
