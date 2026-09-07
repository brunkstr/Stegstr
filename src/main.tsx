import React from "react";
import ReactDOM from "react-dom/client";
import { ErrorBoundary } from "./ErrorBoundary";
import App from "./App";
import { installAgentApi } from "./agent-api";

// Makes `window.stegstr` available so the running app can be driven by a
// script or an agent, not only through the UI. See src/agent-api.ts.
installAgentApi();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
