// `/texts/:token` (docs/plan.md §1.98): the page where a person chooses to get texts from a
// business that uses Mezonas. No sign-in: the signed link says whose page it is (the client's
// sign-up link, or one person's invitation). The person gives their mobile number, ticks the box
// beside the exact words they agree to, and presses "Text me". Texting is a choice: the box starts
// unticked, nothing else on the page needs it, and an invitation can be turned down for good.
import { type FormEvent, type ReactNode, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import { isApiError } from "../api/client";
import { apiRoutes } from "../api/routes";
import { useApi, useApiClient } from "../api/useApi";
import { useI18n } from "../i18n/i18n";
import { Logo } from "../ui/brand";
import { Field, TextInput } from "../ui/forms";
import { Button, Card, ErrorNotice, Loading } from "../ui/primitives";

const TERMS_URL = "https://mezonas.com/sms-terms";
const PRIVACY_URL = "https://mezonas.com/privacy";

function Frame({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return (
    <div
      className="flex min-h-screen flex-col items-center justify-center gap-8 bg-paper px-4 py-10"
      data-testid="text-signup"
    >
      <Logo height={22} />
      <Card className="w-full max-w-md" pad>
        {children}
      </Card>
      <p className="max-w-md text-center text-sm text-ink-muted">
        {t("textSignup.footer")}{" "}
        <a className="underline" href={TERMS_URL}>
          {t("textSignup.terms")}
        </a>{" "}
        ·{" "}
        <a className="underline" href={PRIVACY_URL}>
          {t("textSignup.privacy")}
        </a>
      </p>
    </div>
  );
}

/** A number as people read it: (512) 555-0177 for a US or Canadian one. */
function shown(e164: string | null): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 ?? "");
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : (e164 ?? "");
}

export function TextSignupScreen() {
  const { t } = useI18n();
  const api = useApiClient();
  const { token = "" } = useParams();
  const location = useLocation();
  // A link too short or too long to be one of ours is no good: nothing to ask the API.
  const wellFormed = token.length >= 10 && token.length <= 2000;
  const view = useApi(
    apiRoutes.textSignupView,
    wellFormed ? { params: { token }, cache: "none" } : null,
  );
  const [name, setName] = useState("");
  const [phone, setPhone] = useState<string | null>(null);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<"sent" | "pending" | null>(null);
  const [declined, setDeclined] = useState(false);
  const [askingNo, setAskingNo] = useState(
    new URLSearchParams(location.search).get("decline") === "1",
  );

  if (wellFormed && view.loading && !view.data) {
    return (
      <Frame>
        <Loading />
      </Frame>
    );
  }
  if (!view.data) {
    const gone = !wellFormed || (isApiError(view.error) && view.error.status === 404);
    return (
      <Frame>
        <h1 className="type-heading text-ink">{t("textSignup.goneTitle")}</h1>
        <p className="mt-2 text-ink-muted" data-testid="text-signup-gone">
          {gone ? t("textSignup.gone") : null}
        </p>
        {!gone && view.error ? <ErrorNotice error={view.error} onRetry={view.reload} /> : null}
      </Frame>
    );
  }

  const v = view.data;
  const client = v.client;
  const number = phone ?? shown(v.phone);

  if (done) {
    return (
      <Frame>
        <h1 className="type-heading text-ink">{t("textSignup.doneTitle")}</h1>
        <p className="mt-2 text-ink" data-testid="text-signup-done">
          {done === "sent"
            ? t("textSignup.doneSent", { client })
            : t("textSignup.donePending", { client })}
        </p>
        <p className="mt-2 text-sm text-ink-muted">{t("textSignup.stopAnyTime")}</p>
      </Frame>
    );
  }
  if (declined) {
    return (
      <Frame>
        <h1 className="type-heading text-ink">{t("textSignup.declinedTitle")}</h1>
        <p className="mt-2 text-ink" data-testid="text-signup-declined">
          {t("textSignup.declined", { client })}
        </p>
      </Frame>
    );
  }
  if (v.state === "signed_up") {
    return (
      <Frame>
        <h1 className="type-heading text-ink">{t("textSignup.title", { client })}</h1>
        <p className="mt-2 text-ink" data-testid="text-signup-already">
          {t("textSignup.already", { client })}
        </p>
        <p className="mt-2 text-sm text-ink-muted">{t("textSignup.stopAnyTime")}</p>
      </Frame>
    );
  }

  async function decline() {
    setBusy(true);
    setError(null);
    try {
      await api.call(apiRoutes.textSignupDecline, { params: { token } });
      setDeclined(true);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  if (askingNo && v.kind === "invitation") {
    return (
      <Frame>
        <h1 className="type-heading text-ink">{t("textSignup.declineTitle", { client })}</h1>
        <p className="mt-2 text-ink-muted">{t("textSignup.declineHelp")}</p>
        {error ? (
          <div className="mt-4">
            <ErrorNotice error={error} />
          </div>
        ) : null}
        <div className="mt-5 flex flex-wrap gap-3">
          <Button onClick={() => void decline()} disabled={busy} data-testid="text-signup-decline">
            {t("textSignup.declineConfirm")}
          </Button>
          <Button variant="ghost" onClick={() => setAskingNo(false)} disabled={busy}>
            {t("textSignup.declineBack")}
          </Button>
        </div>
      </Frame>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!agree) return;
    setBusy(true);
    setError(null);
    try {
      const out = await api.call(apiRoutes.textSignupSubmit, {
        params: { token },
        body: {
          ...(v.kind === "link" ? { name: name.trim() } : {}),
          phone: number,
          agree: true,
          wordingVersion: v.wordingVersion,
        },
      });
      setDone(out.confirmation);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const first = v.name?.trim().split(/\s+/)[0];
  const ready = agree && number.trim() !== "" && (v.kind === "invitation" || name.trim() !== "");

  return (
    <Frame>
      <p className="eyebrow text-ink-muted">{t("textSignup.eyebrow")}</p>
      <h1 className="type-heading text-ink" data-testid="text-signup-title">
        {t("textSignup.title", { client })}
      </h1>
      <p className="mt-2 text-ink">
        {first
          ? t("textSignup.introNamed", { name: first, client })
          : t("textSignup.intro", { client })}
      </p>
      <p className="mt-2 text-sm text-ink-muted">{t("textSignup.optional")}</p>
      <form className="mt-5 flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
        {v.kind === "link" ? (
          <Field label={t("textSignup.name")}>
            <TextInput
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              required
              data-testid="text-signup-name"
            />
          </Field>
        ) : null}
        <Field label={t("textSignup.phone")} hint={t("textSignup.phoneHint")}>
          <TextInput
            type="tel"
            value={number}
            onChange={(e) => setPhone(e.target.value)}
            autoComplete="tel"
            inputMode="tel"
            required
            data-testid="text-signup-phone"
          />
        </Field>
        <label className="flex items-start gap-3 rounded-md border border-line p-3 text-sm text-ink">
          <input
            type="checkbox"
            className="mt-0.5 size-4 shrink-0 accent-slate"
            checked={agree}
            onChange={(e) => setAgree(e.target.checked)}
            data-testid="text-signup-agree"
          />
          <span data-testid="text-signup-terms">{v.terms}</span>
        </label>
        {error ? <ErrorNotice error={error} /> : null}
        <Button
          type="submit"
          variant="primary"
          disabled={!ready || busy}
          data-testid="text-signup-submit"
        >
          {t("textSignup.submit")}
        </Button>
      </form>
      {v.kind === "invitation" ? (
        <p className="mt-4 text-sm">
          <button
            type="button"
            className="text-ink-muted underline"
            onClick={() => setAskingNo(true)}
            data-testid="text-signup-no"
          >
            {t("textSignup.no")}
          </button>
        </p>
      ) : null}
    </Frame>
  );
}
