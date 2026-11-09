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
import type { PlainKey } from "../i18n/catalog";
import { EN, type I18n, useI18n } from "../i18n/i18n";
import { Logo, PRODUCT_NAME } from "../ui/brand";
import { Icon } from "../ui/icons";
import { Button, buttonClass, Card, cx, ErrorNotice, Loading } from "../ui/primitives";
import { homeFor, useSessionState } from "./session";

const ROLE_LABEL = {
  operator: "signin.role.operator",
  client_admin: "signin.role.client_admin",
  client_user: "signin.role.client_user",
} satisfies Record<string, PlainKey>;

/** What the sign-in page says when the API sent the browser back with `?error=<code>`. */
const SIGN_IN_ERRORS: Record<string, PlainKey> = {
  not_invited: "signin.error.not_invited",
  email_not_verified: "signin.error.email_not_verified",
  email_taken: "signin.error.email_taken",
  sign_in_method: "signin.error.sign_in_method",
  misconfigured: "signin.error.misconfigured",
  adapter_disabled: "signin.error.misconfigured",
};

/** Before a session, in the browser's language (plan §1.18). */
export function signInErrorText(code: string | null, { t }: Pick<I18n, "t"> = EN): string | null {
  if (!code) return null;
  return t(SIGN_IN_ERRORS[code] ?? "signin.error.default");
}

export function SignInScreen() {
  const { t } = useI18n();
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
        <h1 className="type-heading text-ink">{t("signin.title", { product: PRODUCT_NAME })}</h1>
        <div className="mt-4">
          <ErrorNotice error={new Error(t("signin.error.misconfigured"))} />
        </div>
      </SignInFrame>
    );
  }
  // The dev adapter, or an API too old to answer: the development sign-in, as before.
  return <DevSignIn />;
}

/** UI-3a: the logo, one card on the paper, and who to ask for access; the same for every sign-in. */
function SignInFrame({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return (
    <div
      className="flex min-h-screen flex-col items-center justify-center gap-8 bg-paper px-4 py-10"
      data-testid="signin-frame"
    >
      <Logo height={26} />
      <Card className="w-full max-w-md" pad>
        {children}
      </Card>
      <p className="max-w-md text-center text-sm text-ink-muted">{t("signin.needAccess")}</p>
    </div>
  );
}

function WorkOSSignIn() {
  const i18n = useI18n();
  const { t } = i18n;
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const next = params.get("next");
  const error = signInErrorText(params.get("error"), i18n);
  // `next` is only ever a path inside this app; the API checks `return_to` again.
  const target = next?.startsWith("/") && !next.startsWith("//") ? next : null;
  const href = `/api/auth/sign-in${target ? `?return_to=${encodeURIComponent(target)}` : ""}`;
  return (
    <SignInFrame>
      <h1 className="type-heading text-ink">{t("signin.title", { product: PRODUCT_NAME })}</h1>
      <p className="mt-1 mb-5 text-ink-muted">{t("signin.workosHelp")}</p>
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
        {t("signin.continue")}
      </a>
    </SignInFrame>
  );
}

function DevSignIn() {
  const i18n = useI18n();
  const { t } = i18n;
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
        setFailure(new Error(t("signin.noSession")));
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
    <SignInFrame>
      <h1 className="type-heading text-ink">{t("signin.title", { product: PRODUCT_NAME })}</h1>
      <p className="mt-1 mb-5 text-ink-muted">{t("signin.devHelp")}</p>
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
                      {u.email} · {describe(u, i18n)}
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
            {t("signin.email")}
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
            {t("signin.submit")}
          </Button>
        </form>
      ) : null}
      {failure ? (
        <div className="mt-4">
          <ErrorNotice error={failure} />
        </div>
      ) : null}
    </SignInFrame>
  );
}

function describe(
  u: {
    operator: boolean;
    tenants: { name: string; role: keyof typeof ROLE_LABEL }[];
  },
  { t }: Pick<I18n, "t">,
): string {
  if (u.operator) {
    const n = new Set(u.tenants.map((c) => c.name)).size;
    return t("signin.operatorClients", { count: n });
  }
  const c = u.tenants[0];
  return c ? `${t(ROLE_LABEL[c.role])} · ${c.name}` : t("signin.noClient");
}
