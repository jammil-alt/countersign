// `/sign-in`: local and e2e sign-in through the dev adapter (plan §1.1 "Auth provider"): pick a
// seeded user, or type a seeded user's email when the API does not list them. WorkOS sign-in
// replaces this screen on deployed environments.
import { type FormEvent, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { isApiError } from "../api/client";
import { apiRoutes } from "../api/routes";
import { useApi, useApiClient } from "../api/useApi";
import { Mark, PLATFORM_NAME } from "../shell/Shell";
import { Button, Card, ErrorNotice, Loading } from "../ui/primitives";
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
    <div className="flex min-h-screen items-center justify-center bg-ground px-4">
      <Card className="w-full max-w-md p-6 elevation-md">
        <div className="mb-5 flex items-center gap-3">
          <Mark />
          <h1 className="text-xl font-semibold text-primary">Sign in to {PLATFORM_NAME}</h1>
        </div>
        <p className="mb-4 text-secondary">Development sign-in as a seeded user.</p>
        {users.loading ? <Loading /> : null}
        {users.error && !noList ? <ErrorNotice error={users.error} /> : null}
        {users.data ? (
          <ul className="mb-5 flex flex-col gap-2" data-testid="signin-users">
            {users.data.users.map((u) => (
              <li key={u.email}>
                <button
                  type="button"
                  data-testid={`signin-user-${u.email}`}
                  disabled={busy}
                  onClick={() => void signIn(u.email)}
                  className="w-full rounded-md border border-edge bg-card px-4 py-3 text-left hover:bg-hover disabled:opacity-60"
                >
                  <span className="block font-medium text-primary">{u.name ?? u.email}</span>
                  <span className="block text-sm text-secondary">
                    {u.email} · {describe(u)}
                  </span>
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
              className="h-control min-w-0 flex-1 rounded-sm border border-control bg-card px-3"
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
