// @countersign/web: the Mezonas app (React + Vite). Talks to apps/api over HTTP using the route
// contract in @countersign/core; screens follow the owner's v1 layouts (docs/design/) on the Mezonas
// design system (packages/design-system).
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { reportScreenCrash, startErrorTracking } from "./observability";
import { startSessionEarly } from "./session/early";
import { isStaleBuildError, reloadForNewBuild, watchForNewBuild } from "./shell/stale-build";
import { applyStoredTheme } from "./shell/theme";
import "./styles.css";

startErrorTracking();
// A tab from before a deploy reloads for the new build instead of failing to open a screen.
watchForNewBuild();
applyStoredTheme();
// Who is signed in, asked before React mounts; the session provider takes the answer (4.3).
startSessionEarly();

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root");
// A screen that throws while rendering reaches Sentry with its component stack (a no-op where
// error tracking is off), unless it is a screen's file from an old build: then the page reloads.
const onScreenError = (error: unknown, info: { componentStack?: string | undefined }) => {
  if (isStaleBuildError(error) && reloadForNewBuild()) return;
  reportScreenCrash(error, info.componentStack);
};
createRoot(root, {
  onUncaughtError: onScreenError,
  onCaughtError: onScreenError,
}).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
