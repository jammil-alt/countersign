// `/sign-in`. The API says which sign-in this environment uses (plan §1.1 "Auth provider"):
// - WorkOS (staging, production): one button that goes to WorkOS and comes back signed in, and the
//   reason when a sign-in did not complete (`?error=<code>`, set by the API's sign-in routes);
// - the dev adapter (local, e2e): pick a seeded user, or type a seeded user's email when the API
//   does not list them.
import { type FormEvent, type ReactNode, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { isApiError } from "../api/client";
import { apiRoutes } from "../api/routes";
import { useApi, useApiClient } from "../api/useApi";
import { Logo, PRODUCT_NAME } from "../ui/brand";
import { Icon } from "../ui/icons";
import { Button, buttonClass, Card, cx, ErrorNotice, Loading } from "../ui/primitives";
import { homeFor, useSessionState } from "./session";

const ROLE_LABEL = {
  operator: "Operator",
  client_admin: "Client admin",
  client_user: "Client user",
};

/** What the sign-in page says when the API sent the browser back with `?error=<code>`. */
const SIGN_IN_ERRORS: Record<string, string> = {
  not_invited:
    "This email address has not been invited to Mezonas. Ask your Mezonas contact for an invitation, then sign in with the same address.",
  email_not_verified: "Verify your email address on the sign-in page first, then sign in again.",
  email_taken: "This email address is tied to a different sign-in. Contact us to sort it out.",
  misconfigured: "Sign-in is not set up on this site yet.",
  adapter_disabled: "Sign-in is not set up on this site yet.",
};
const SIGN_IN_ERROR_DEFAULT = "Sign-in did not finish. Start again.";

export function signInErrorText(code: string | null): string | null {
  if (!code) return null;
  return SIGN_IN_ERRORS[code] ?? SIGN_IN_ERROR_DEFAULT;
}

export function SignInScreen() {
  const provider = useApi(apiRoutes.authProvider);
  if (provider.loading) {
    return (
      <SignInFrame>
        <Loading />
      </SignInFrame>
    );
  }
  if (provider.data?.provider === "workos") return <WorkOSSignIn />;
  if (provider.data?.provider === "unavailable") {
    return (
      <SignInFrame>
        <h1 className="type-heading text-ink">Sign in to {PRODUCT_NAME}</h1>
        <div className="mt-4">
          <ErrorNotice error={new Error(SIGN_IN_ERRORS.misconfigured)} />
        </div>
      </SignInFrame>
    );
  }
  // The dev adapter, or an API too old to answer: the development sign-in, as before.
  return <DevSignIn />;
}

function SignInFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-8 bg-paper px-4 py-10">
      <Logo height={26} />
      <Card className="w-full max-w-lg p-6">{children}</Card>
    </div>
  );
}

function WorkOSSignIn() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const next = params.get("next");
  const error = signInErrorText(params.get("error"));
  // `next` is only ever a path inside this app; the API checks `return_to` again.
  const target = next?.startsWith("/") && !next.startsWith("//") ? next : null;
  const href = `/api/auth/sign-in${target ? `?return_to=${encodeURIComponent(target)}` : ""}`;
  return (
    <SignInFrame>
      <h1 className="type-heading text-ink">Sign in to {PRODUCT_NAME}</h1>
      <p className="mt-1 mb-5 text-ink-muted">
        Use the email address you were invited with. We send you to our sign-in page and back.
      </p>
      {error ? (
        <div className="mb-5" data-testid="signin-error">
          <ErrorNotice error={new Error(error)} />
        </div>
      ) : null}
      <a
        href={href}
        className={buttonClass("primary", "w-full justify-center")}
        data-testid="signin-workos"
      >
        Continue to sign in
      </a>
    </SignInFrame>
  );
}

function DevSignIn() {
  const client = useApiClient();
  const { refresh } = useSessionState();
  const navigate = useNavigate();
  const location = useLocation();
  const users = useApi(apiRoutes.devUsers);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [email, setEmail] = useState("");

  const next = new URLSearchParams(location.search).get("next");

  async function signIn(address: string) {
    setBusy(true);
    setFailure(null);
    try {
      await client.call(apiRoutes.devSignIn, { body: { email: address.trim() } });
      const state = await refresh();
      if (state.status === "signed_in") {
        // `next` is only ever a path inside this app (set by the sign-in gate).
        const target = next?.startsWith("/") && !next.startsWith("//") ? next : null;
        navigate(target ?? homeFor(state.session), { replace: true });
      } else {
        setFailure(new Error("Signed in, but the session did not open. Is this user seeded?"));
      }
    } catch (e) {
      setFailure(e);
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (email.trim()) void signIn(email);
  }

  // DECISION: the API may not list seeded users (no such route yet); a 404 falls back to typing
  // the email, which is all the dev adapter needs.
  const noList = isApiError(users.error) && users.error.status === 404;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-8 bg-paper px-4 py-10">
      <Logo height={26} />
      <Card className="w-full max-w-lg p-6">
        <h1 className="type-heading text-ink">Sign in to {PRODUCT_NAME}</h1>
        <p className="mt-1 mb-5 text-ink-muted">Development sign-in: pick a seeded user.</p>
        {users.loading ? <Loading /> : null}
        {users.error && !noList ? <ErrorNotice error={users.error} /> : null}
        {users.data ? (
          <ul
            className="mb-5 overflow-hidden rounded-md border border-line"
            data-testid="signin-users"
          >
            {users.data.users.map((u) => (
              <li key={u.email} className="border-b border-line last:border-b-0">
                <button
                  type="button"
                  data-testid={`signin-user-${u.email}`}
                  disabled={busy}
                  onClick={() => void signIn(u.email)}
                  className="ds-listrow border-b-0 text-left disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <span
                      aria-hidden
                      className={cx(
                        "ds-avatar ds-avatar--sm font-medium",
                        u.operator ? "mz-lead" : "ds-avatar--self",
                      )}
                    >
                      {(u.name ?? u.email).slice(0, 1).toUpperCase()}
                    </span>
                    <span className="min-w-0">
                      <span className="ds-listrow__title font-medium text-ink">
                        {u.name ?? u.email}
                      </span>
                      <span className="ds-listrow__meta truncate">
                        {u.email} · {describe(u)}
                      </span>
                    </span>
                  </span>
                  <Icon name="chevron-right" className="text-ink-muted" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {!users.loading ? (
          <form onSubmit={submit} className="flex gap-2">
            <label className="sr-only" htmlFor="signin-email">
              Email
            </label>
            <input
              id="signin-email"
              data-testid="signin-email-input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="operator@example.com"
              className="ds-input min-w-0 flex-1"
            />
            <Button
              type="submit"
              variant="primary"
              disabled={busy || !email.trim()}
              data-testid="signin-email-submit"
            >
              Sign in
            </Button>
          </form>
        ) : null}
        {failure ? (
          <div className="mt-4">
            <ErrorNotice error={failure} />
          </div>
        ) : null}
      </Card>
    </div>
  );
}

function describe(u: {
  operator: boolean;
  tenants: { name: string; role: keyof typeof ROLE_LABEL }[];
}): string {
  if (u.operator) {
    const n = new Set(u.tenants.map((t) => t.name)).size;
    return `Operator · ${n} ${n === 1 ? "client" : "clients"}`;
  }
  const t = u.tenants[0];
  return t ? `${ROLE_LABEL[t.role]} · ${t.name}` : "No client";
}
