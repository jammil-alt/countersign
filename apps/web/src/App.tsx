// The SPA: sign-in, the back office (`/ops/*`) and the client portal (everything else), each of
// the two its own chunk, one app with two layouts (plan §1.2 "Back office and portal in one app").

import { MOBILE_CONFIRM_PATH } from "@countersign/core";
import { lazy, type ReactNode, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import type { ApiClient } from "./api/client";
import { ApiProvider } from "./api/useApi";
import { loadCatalog } from "./i18n/catalog";
import { SessionLanguage } from "./i18n/SessionLanguage";
import { SignInScreen } from "./session/SignIn";
import { StillFrame } from "./session/StillFrame";
import { SECOND_STEP_PATH, SessionProvider, useSessionState } from "./session/session";
import { IconSprite } from "./ui/icons";
import { ErrorNotice } from "./ui/primitives";

/**
 * The back office's own chunk. Opened at an /ops address, it starts loading with the bundle, beside
 * the session call, instead of after it (docs/audit-plan.md 4.3); elsewhere, only once an operator
 * reaches /ops.
 */
// DECISION (§1.208): the back office reads in English always, and English is not in the first load
// any more, so its chunk and English's load together and it shows once both are here.
const loadOpsApp = () =>
  Promise.all([import("./ops/OpsApp"), loadCatalog("en")]).then(([opsApp]) => opsApp);
let opsAppEarly: ReturnType<typeof loadOpsApp> | null = null;
const OpsApp = lazy(() => opsAppEarly ?? loadOpsApp());
/**
 * The client portal's own chunk, the same way (H9, docs/plan.md §1.192): its layout and screens
 * are not in the first load, so sign-in and the pages opened from a link don't carry them. Opened
 * at a portal address, it starts loading with the bundle, beside the session call, so a client's
 * first screen waits no longer than it did when the portal was in the bundle.
 */
// DECISION: early for every address that is not the back office's or a page outside the portal
// (sign-in and its steps, a texting sign-up, a form, an invite's welcome page): those are the
// routes above `/*` in AppRoutes, and a client's user lands on the portal from anywhere else.
const NOT_PORTAL = /^\/(ops|sign-in|texts|f|start)(\/|$)/;
const loadPortalApp = () => import("./portal/PortalApp").then((m) => ({ default: m.PortalApp }));
let portalAppEarly: ReturnType<typeof loadPortalApp> | null = null;
const PortalApp = lazy(() => portalAppEarly ?? loadPortalApp());

/**
 * Starts the chunk the address the app opened at will need, beside the session call. Called once by
 * `main.tsx` before React mounts.
 */
// DECISION: the entry point starts it, not this module as it loads: a test renders AppRoutes in a
// MemoryRouter while jsdom's address is `/`, so loading the module started the portal's whole tree
// in every back-office screen test as well, slowing a busy CI runner for nothing.
export function startChunksEarly(pathname: string): void {
  if (/^\/ops(\/|$)/.test(pathname)) {
    opsAppEarly = loadOpsApp();
    // A client's session never renders the back office; a chunk that failed is reported where it is used.
    opsAppEarly.catch(() => {});
  } else if (!NOT_PORTAL.test(pathname)) {
    portalAppEarly = loadPortalApp();
    // An operator's session never renders the portal; a chunk that failed is reported where it is used.
    portalAppEarly.catch(() => {});
  }
}
// §1.100: the sign-in's second step, only on the way in: its own chunk.
const SecondStepScreen = lazy(() =>
  import("./session/SecondStep").then((m) => ({ default: m.SecondStepScreen })),
);
// §1.219: the page that asks before a sign-in goes to the phone or desktop app: its own chunk.
const AppHandoffScreen = lazy(() =>
  import("./session/AppHandoff").then((m) => ({ default: m.AppHandoffScreen })),
);
// §1.98: the texting sign-up page is opened from a link, never in the app: its own chunk.
const TextSignupScreen = lazy(() =>
  import("./signup/TextSignup").then((m) => ({ default: m.TextSignupScreen })),
);
// §1.121: a "Request info" form, opened from a link a contact was sent: its own chunk.
const FormPageScreen = lazy(() =>
  import("./forms/FormPage").then((m) => ({ default: m.FormPageScreen })),
);
// §1.217: a process interview, opened from a link a contact was sent: its own chunk.
const InterviewPageScreen = lazy(() =>
  import("./interview/InterviewPage").then((m) => ({ default: m.InterviewPageScreen })),
);
// §1.149: the welcome page an invite's link opens, before sign-in: its own chunk.
const SetupLinkScreen = lazy(() =>
  import("./session/SetupLink").then((m) => ({ default: m.SetupLinkScreen })),
);
const WelcomeScreen = lazy(() =>
  import("./onboarding/Welcome").then((m) => ({ default: m.WelcomeScreen })),
);

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/sign-in" element={<SignInScreen />} />
      {/* docs/plan.md §1.100: the sign-in's second step (a code from an app, a text or WhatsApp). */}
      <Route
        path={SECOND_STEP_PATH}
        element={
          <Suspense fallback={<StillFrame />}>
            <SecondStepScreen />
          </Suspense>
        }
      />
      {/* docs/plan.md §1.219: confirm before the session goes to one of our apps. */}
      <Route
        path={MOBILE_CONFIRM_PATH}
        element={
          <Suspense fallback={<StillFrame />}>
            <AppHandoffScreen />
          </Suspense>
        }
      />
      {/* docs/plan.md §1.98: choosing to get texts from a business; no sign-in. */}
      <Route
        path="/texts/:token"
        element={
          <Suspense fallback={<StillFrame />}>
            <TextSignupScreen />
          </Suspense>
        }
      />
      {/* docs/plan.md §1.121: answering a form we sent; no sign-in. */}
      <Route
        path="/f/:token"
        element={
          <Suspense fallback={<StillFrame />}>
            <FormPageScreen />
          </Suspense>
        }
      />
      {/* docs/plan.md §1.217: a process interview we sent; no sign-in. */}
      <Route
        path="/i/:token"
        element={
          <Suspense fallback={<StillFrame />}>
            <InterviewPageScreen />
          </Suspense>
        }
      />
      {/* Owner, 2026-11-19: the emailed link that sets up a first sign-in method; no session. */}
      <Route
        path="/sign-in/setup/:token"
        element={
          <Suspense fallback={<StillFrame />}>
            <SetupLinkScreen />
          </Suspense>
        }
      />
      {/* docs/plan.md §1.149: an invite's welcome page; sign-in starts here. */}
      <Route
        path="/start/:token"
        element={
          <Suspense fallback={<StillFrame />}>
            <WelcomeScreen />
          </Suspense>
        }
      />
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
            <Suspense fallback={<StillFrame />}>
              <PortalApp />
            </Suspense>
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
  if (state.status === "second_step") {
    const next = `${location.pathname}${location.search}`;
    return (
      <Navigate to={`${SECOND_STEP_PATH}?${new URLSearchParams({ return_to: next })}`} replace />
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
