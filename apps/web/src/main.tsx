// @countersign/web: the Mezonas app (React + Vite). Talks to apps/api over HTTP using the route
// contract in @countersign/core; screens follow the owner's v1 layouts (docs/design/) on the Mezonas
// design system (packages/design-system).
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, startChunksEarly } from "./App";
import { startLanguageEarly } from "./i18n/catalog";
import { reportScreenCrash, startErrorTracking } from "./observability";
import { startSessionEarly } from "./session/early";
import {
  isReloadingForNewBuild,
  isStaleBuildError,
  reloadForNewBuild,
  watchForNewBuild,
} from "./shell/stale-build";
import { applyStoredTheme } from "./shell/theme";
import "./styles.css";

startErrorTracking();
// A tab from before a deploy reloads for the new build instead of failing to open a screen.
watchForNewBuild();
applyStoredTheme();
// Who is signed in, asked before React mounts; the session provider takes the answer (4.3).
startSessionEarly();
// The last session's language (no language is in the bundle: docs/plan.md §1.208).
startLanguageEarly();
// The back office's or the portal's chunk, as the address needs, beside the session call.
startChunksEarly(window.location.pathname);

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root");
// A screen that throws while rendering reaches Sentry with its component stack (a no-op where
// error tracking is off), unless it is a screen's file from an old build: then the page reloads
// (or already is, started by `vite:preloadError`).
const onScreenError = (error: unknown, info: { componentStack?: string | undefined }) => {
  if (isStaleBuildError(error) && (isReloadingForNewBuild() || reloadForNewBuild())) return;
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
