// `/start/:token` (docs/plan.md §1.126; docs/cases-plan.md §4.4): the welcome page an invite's link
// opens, seen without sign-in. The client's name, the lead's name and note, what's in it and how
// long, a security line, then Continue with Google, Microsoft or email (WorkOS, with the invited
// address filled in). Back here signed in, the API checks the address against the invite: the
// invited one goes on to Getting started (`/start`), any other sees "This invite is for d•••@…"
// and nothing more. An expired or closed link offers "Ask <lead> for a new one". The words are the
// person's language. The token never signs anyone in.
import {
  firstNameOf,
  intakeSummaryLine,
  type Locale,
  ONBOARDING_WORDS,
  type OnboardingWords,
  type WelcomePageView,
  type WelcomeSignedInView,
} from "@countersign/core";
import { type ReactNode, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { isApiError } from "../api/client";
import { apiRoutes } from "../api/routes";
import { useApi, useApiClient } from "../api/useApi";
import { useI18n } from "../i18n/i18n";
import { SECOND_STEP_PATH, useSessionState } from "../session/session";
import { Logo } from "../ui/brand";
import { Button, buttonClass, Card, ErrorNotice, Loading } from "../ui/primitives";

/** Leaves the app for the API's sign-in route (Back skips this step). */
function leave(url: string) {
  window.location.assign(url);
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex min-h-screen flex-col items-center gap-8 bg-paper px-4 py-10"
      data-testid="welcome-page"
    >
      <Logo height={22} />
      <Card className="w-full max-w-xl" pad>
        {children}
      </Card>
    </div>
  );
}

/** The sign-in this page starts: WorkOS's, by method, coming back here; the dev sign-in locally. */
export function signInHref(
  provider: "workos" | "dev" | "unavailable" | undefined,
  token: string,
  method: "google" | "microsoft" | "email",
  email: string | null,
): string {
  const back = `/start/${token}`;
  if (provider !== "workos") return `/sign-in?next=${encodeURIComponent(back)}`;
  const q = new URLSearchParams({ return_to: back, method });
  if (email) q.set("login_hint", email);
  return `/api/auth/sign-in?${q}`;
}

function LeadNote({ lead, note }: { lead: string; note: string }) {
  return (
    <figure
      className="mt-4 rounded-md border-l-2 border-copper bg-copper-tint px-4 py-3"
      data-testid="welcome-note"
    >
      <blockquote className="whitespace-pre-line text-ink">{note}</blockquote>
      <figcaption className="mt-2 text-sm text-copper-ink">{lead}</figcaption>
    </figure>
  );
}

function AskNew({ token, lead, w }: { token: string; lead: string; w: OnboardingWords }) {
  const api = useApiClient();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (done) {
    return (
      <p className="mt-4 text-ink" data-testid="welcome-asked">
        {w.askedNew(lead)}
      </p>
    );
  }
  return (
    <>
      {error ? (
        <div className="mt-4">
          <ErrorNotice error={error} />
        </div>
      ) : null}
      <div className="mt-5">
        <Button
          variant="primary"
          disabled={busy}
          data-testid="welcome-ask-new"
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await api.call(apiRoutes.welcomeAskNew, { params: { token } });
              setDone(true);
            } catch (err) {
              setError(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          {w.askNew(lead)}
        </Button>
      </div>
    </>
  );
}

/** Signed in: the API decides whether this account is the invited one. */
function SignedIn({
  token,
  view,
  w,
}: {
  token: string;
  view: WelcomePageView;
  w: OnboardingWords;
}) {
  const api = useApiClient();
  const navigate = useNavigate();
  const { signOut } = useSessionState();
  const [result, setResult] = useState<WelcomeSignedInView | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let live = true;
    api
      .call(apiRoutes.welcomeSignedIn, { params: { token } })
      .then((r) => {
        if (!live) return;
        if (r.state === "ok") navigate(r.next, { replace: true });
        else setResult(r);
      })
      .catch((err: unknown) => {
        if (live) setError(err);
      });
    return () => {
      live = false;
    };
  }, [api, token, navigate]);

  if (error) {
    return (
      <Frame>
        <ErrorNotice error={error} />
      </Frame>
    );
  }
  if (!result) {
    return (
      <Frame>
        <p className="text-ink-muted">{w.signingIn}</p>
      </Frame>
    );
  }
  if (result.state === "wrong_account") {
    return (
      <Frame>
        <p className="text-ink" data-testid="welcome-wrong-account">
          {w.wrongAccount(result.invitedEmail)}
        </p>
        <div className="mt-5">
          <Button onClick={() => void signOut()} data-testid="welcome-sign-out">
            {w.signOut}
          </Button>
        </div>
      </Frame>
    );
  }
  return <Closed token={token} view={view} w={w} expired={result.state === "expired"} />;
}

function Closed({
  token,
  view,
  w,
  expired,
}: {
  token: string;
  view: WelcomePageView;
  w: OnboardingWords;
  expired: boolean;
}) {
  return (
    <Frame>
      <h1 className="type-heading text-ink" data-testid="welcome-closed">
        {expired ? w.expiredTitle : w.closedTitle}
      </h1>
      <p className="mt-2 text-ink-muted">{view.client}</p>
      <AskNew token={token} lead={firstNameOf(view.lead.name)} w={w} />
    </Frame>
  );
}

export function WelcomeScreen({ go = leave }: { go?: (url: string) => void } = {}) {
  const reader = useI18n().locale;
  const { token = "" } = useParams();
  const { state } = useSessionState();
  const navigate = useNavigate();
  const wellFormed = token.length >= 10 && token.length <= 2000;
  const view = useApi(
    apiRoutes.welcomePage,
    wellFormed ? { params: { token }, cache: "none" } : null,
  );
  const provider = useApi(apiRoutes.authProvider);
  const v = view.data ?? null;
  const locale: Locale = v?.language ?? reader;
  const w = ONBOARDING_WORDS[locale] ?? ONBOARDING_WORDS.en;

  // A sign-in waiting on its second step finishes it, then comes back here.
  useEffect(() => {
    if (state.status === "second_step") {
      navigate(`${SECOND_STEP_PATH}?${new URLSearchParams({ return_to: `/start/${token}` })}`, {
        replace: true,
      });
    }
  }, [state.status, navigate, token]);

  if (wellFormed && (view.loading || state.status === "loading") && !v) {
    return (
      <Frame>
        <Loading />
      </Frame>
    );
  }
  if (!v) {
    const gone = !wellFormed || (isApiError(view.error) && view.error.status === 404);
    return (
      <Frame>
        <p className="text-ink" data-testid="welcome-gone">
          {gone ? w.notFound : null}
        </p>
        {!gone && view.error ? <ErrorNotice error={view.error} onRetry={view.reload} /> : null}
      </Frame>
    );
  }
  if (v.state !== "open") {
    return <Closed token={token} view={v} w={w} expired={v.state === "expired"} />;
  }
  if (state.status === "signed_in") return <SignedIn token={token} view={v} w={w} />;

  const lead = v.lead.name;
  const href = (method: "google" | "microsoft" | "email") =>
    signInHref(provider.data?.provider, token, method, v.email);
  return (
    <Frame>
      <p className="eyebrow text-copper-ink">{w.fromLead(lead)}</p>
      <h1 className="type-heading mt-1 text-ink" data-testid="welcome-title">
        {w.pageTitle(v.client)}
      </h1>
      {v.note ? <LeadNote lead={lead} note={v.note} /> : null}
      {v.summary ? (
        <div className="mt-5">
          <h2 className="text-sm font-medium text-ink">{w.whatsInTitle}</h2>
          <p className="mt-1 text-ink" data-testid="welcome-summary">
            {intakeSummaryLine(locale, v.client, v.summary)}.
          </p>
        </div>
      ) : null}
      <p className="mt-5 text-sm text-ink-muted">{w.aboutMezonas}</p>
      <div className="mt-6 flex flex-col gap-3">
        {(
          [
            ["google", w.continueGoogle],
            ["microsoft", w.continueMicrosoft],
            ["email", w.continueEmail],
          ] as const
        ).map(([method, label], n) => (
          <a
            key={method}
            href={href(method)}
            onClick={(e) => {
              e.preventDefault();
              go(href(method));
            }}
            className={buttonClass(n === 0 ? "primary" : "secondary", "justify-center")}
            data-testid={`welcome-${method}`}
          >
            {label}
          </a>
        ))}
      </div>
      {v.email ? (
        <p className="mt-4 text-sm text-ink-muted" data-testid="welcome-address">
          {w.signInAs(v.email)}
        </p>
      ) : null}
      <p className="mt-1 text-sm text-ink-muted">{w.security}</p>
    </Frame>
  );
}
