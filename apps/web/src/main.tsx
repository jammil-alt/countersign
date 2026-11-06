// @countersign/web: the Mezonas app (React + Vite). Talks to apps/api over HTTP using the route
// contract in @countersign/core; screens follow the owner's v1 layouts (docs/design/) on the Mezonas
// design system (packages/design-system).
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { reportScreenCrash, startErrorTracking } from "./observability";
import { applyStoredTheme } from "./shell/theme";
import "./styles.css";

startErrorTracking();
applyStoredTheme();

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root");
// A screen that throws while rendering reaches Sentry with its component stack (a no-op where
// error tracking is off).
createRoot(root, {
  onUncaughtError: (error, info) => reportScreenCrash(error, info.componentStack),
  onCaughtError: (error, info) => reportScreenCrash(error, info.componentStack),
}).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
