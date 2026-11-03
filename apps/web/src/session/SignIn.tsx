// `/sign-in`: local and e2e sign-in through the dev adapter (plan §1.1 "Auth provider"): pick a
// seeded user, or type a seeded user's email when the API does not list them. WorkOS sign-in
// replaces this screen on deployed environments.
import { type FormEvent, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { isApiError } from "../api/client";
import { apiRoutes } from "../api/routes";
import { useApi, useApiClient } from "../api/useApi";
import { Logo, PRODUCT_NAME } from "../ui/brand";
import { Icon } from "../ui/icons";
import { Button, Card, cx, ErrorNotice, Loading } from "../ui/primitives";
import { homeFor, useSessionState } from "./session";

const ROLE_LABEL = {
  operator: "Operator",
  client_admin: "Client admin",
  client_user: "Client user",
};

export function SignInScreen() {
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
