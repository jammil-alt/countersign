// The SPA: sign-in, the back office (`/ops/*`, code-split) and the client portal (everything
// else), one app with two layouts (plan §1.2 "Back office and portal in one app").
import { lazy, type ReactNode, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import type { ApiClient } from "./api/client";
import { ApiProvider } from "./api/useApi";
import { SessionLanguage } from "./i18n/SessionLanguage";
import { PortalApp } from "./portal/PortalApp";
import { SignInScreen } from "./session/SignIn";
import { StillFrame } from "./session/StillFrame";
import { SessionProvider, useSessionState } from "./session/session";
import { IconSprite } from "./ui/icons";
import { ErrorNotice } from "./ui/primitives";

/**
 * The back office's own chunk. Opened at an /ops address, it starts loading with the bundle, beside
 * the session call, instead of after it (docs/audit-plan.md 4.3); elsewhere, only once an operator
 * reaches /ops.
 */
const loadOpsApp = () => import("./ops/OpsApp");
const opsAppEarly =
  typeof window !== "undefined" && /^\/ops(\/|$)/.test(window.location.pathname)
    ? loadOpsApp()
    : null;
// A client's session never renders the back office; a chunk that failed is reported where it is used.
opsAppEarly?.catch(() => {});
const OpsApp = lazy(() => opsAppEarly ?? loadOpsApp());

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/sign-in" element={<SignInScreen />} />
      <Route
        path="/ops/*"
        element={
          <RequireSession surface="ops">
            <Suspense fallback={<StillFrame />}>
              <OpsApp />
            </Suspense>
          </RequireSession>
        }
      />
      <Route
        path="/*"
        element={
          <RequireSession surface="portal">
            <PortalApp />
          </RequireSession>
        }
      />
    </Routes>
  );
}

/** A tool's sign-in callback page in the portal (`/connections/:connector/callback`). */
const PORTAL_CALLBACK = /^\/connections\/[a-z0-9][a-z0-9_-]*\/callback$/;

/**
 * Signed out → sign-in (and back here after). Operators belong in /ops and client users in the
 * portal; the API enforces roles on every route, this only sends each to their own surface.
 */
function RequireSession({ surface, children }: { surface: "ops" | "portal"; children: ReactNode }) {
  const { state, refresh } = useSessionState();
  const location = useLocation();

  // Until the session (and its language) is known: the still frame index.html showed, unchanged.
  if (state.status === "loading") return <StillFrame />;
  if (state.status === "error") {
    return (
      <Centered>
        <ErrorNotice error={state.error} onRetry={() => void refresh()} />
      </Centered>
    );
  }
  if (state.status === "signed_out") {
    const next = `${location.pathname}${location.search}`;
    const to = next === "/" ? "/sign-in" : `/sign-in?next=${encodeURIComponent(next)}`;
    return <Navigate to={to} replace />;
  }
  // DECISION: an operator opening a portal URL goes to the back office; seeing the portal as a
  // client sees it ("view as client") is not in v1 scope.
  if (surface === "ops" && !state.session.operator) return <Navigate to="/" replace />;
  if (surface === "portal" && state.session.operator) {
    // DECISION: a provider registered with the portal's callback page (Zoho, Podio) returns the
    // operator's Sandbox sign-in there; it goes on, parameters and all, to the back office's page,
    // whose API route checks the signed state. Client users' sign-ins are untouched.
    if (PORTAL_CALLBACK.test(location.pathname)) {
      return <Navigate to={`/ops${location.pathname}${location.search}`} replace />;
    }
    return <Navigate to="/ops" replace />;
  }
  return <>{children}</>;
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center px-6">{children}</div>;
}

export function AppProviders({ client, children }: { client?: ApiClient; children: ReactNode }) {
  const inner = (
    <SessionProvider>
      <SessionLanguage>{children}</SessionLanguage>
    </SessionProvider>
  );
  return client ? <ApiProvider client={client}>{inner}</ApiProvider> : inner;
}

export function App() {
  return (
    <BrowserRouter>
      <IconSprite />
      <AppProviders>
        <AppRoutes />
      </AppProviders>
    </BrowserRouter>
  );
}
