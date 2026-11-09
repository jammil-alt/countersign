// The SPA: sign-in, the back office (`/ops/*`, code-split) and the client portal (everything
// else), one app with two layouts (plan §1.2 "Back office and portal in one app").
import { lazy, type ReactNode, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import type { ApiClient } from "./api/client";
import { ApiProvider } from "./api/useApi";
import { SessionLanguage } from "./i18n/SessionLanguage";
import { PortalApp } from "./portal/PortalApp";
import { SecondFactorScreen } from "./session/SecondFactor";
import { SignInScreen } from "./session/SignIn";
import { SessionProvider, useSessionState } from "./session/session";
import { IconSprite } from "./ui/icons";
import { ErrorNotice, Loading } from "./ui/primitives";

/** Its own chunk: only reached after the operator check below. */
const OpsApp = lazy(() => import("./ops/OpsApp"));

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/sign-in" element={<SignInScreen />} />
      <Route
        path="/ops/*"
        element={
          <RequireSession surface="ops">
            <Suspense
              fallback={
                <Centered>
                  <Loading />
                </Centered>
              }
            >
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
 * Signed out → sign-in (and back here after); signed in but pending → the second step. Operators belong in /ops and client users in the
 * portal; the API enforces roles on every route, this only sends each to their own surface.
 */
function RequireSession({ surface, children }: { surface: "ops" | "portal"; children: ReactNode }) {
  const { state, refresh } = useSessionState();
  const location = useLocation();

  if (state.status === "loading") {
    return (
      <Centered>
        <Loading />
      </Centered>
    );
  }
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
  // Signed in with WorkOS, not yet past the second step (docs/plan.md §1.83): the step, wherever
  // the person was going; passing it loads the session and this page.
  if (state.status === "second_factor") return <SecondFactorScreen />;
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
