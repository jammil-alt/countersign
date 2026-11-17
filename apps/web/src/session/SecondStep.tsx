// `/sign-in/second-step` (docs/plan.md §1.100): after WorkOS checks the password, the sign-in
// waits here until the person proves a second factor. The API's callback sends a pending sign-in
// here with `?return_to=`; the app sends one here too when `/api/session` answers 401
// `second_factor_required`.
//
// First sign-in: pick a method (operators: an authenticator app only), set it up (the app's key,
// or a number to text or WhatsApp a code to), enter the code, then save the 10 recovery codes,
// shown once. Later sign-ins: the code from the method (a text or WhatsApp code is sent on
// request), or a recovery code instead. "Remember this browser for 30 days" skips the step on
// this browser after. The routes are the API's own (packages/core `secondFactorRoutes`); this page
// only asks and shows, every check is on the server.
//
// DECISION (§1.100): no QR code yet. The authenticator app's key is shown to type (every app
// takes one), with a link that opens the app directly on a phone; the QR image waits on adding a
// QR library to the web app.
import {
  RECOVERY_CODE_COUNT,
  type SecondFactorKind,
  type SecondFactorMethodView,
  type SecondFactorStatus,
} from "@countersign/core";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { apiRoutes } from "../api/routes";
import { useApiClient } from "../api/useApi";
import type { PlainKey } from "../i18n/catalog";
import { errorText } from "../i18n/errors";
import { useI18n } from "../i18n/i18n";
import { Field, Select, TextInput } from "../ui/forms";
import { Button, ErrorNotice, Loading } from "../ui/primitives";
import { SignInFrame } from "./SignIn";
import { homeFor, safeReturnTo, useSessionState } from "./session";

const METHOD_LABEL: Record<SecondFactorKind, PlainKey> = {
  totp: "secondStep.method.totp",
  sms: "secondStep.method.sms",
  whatsapp: "secondStep.method.whatsapp",
};
const METHOD_HINT: Record<SecondFactorKind, PlainKey> = {
  totp: "secondStep.method.totpHint",
  sms: "secondStep.method.smsHint",
  whatsapp: "secondStep.method.whatsappHint",
};

/**
 * The countries offered for a text or WhatsApp number, with their calling codes. A short list of
 * where clients are; anything else can be typed in full with its `+`.
 */
// DECISION (§1.100): a short list, United States first; a number typed with its own `+` wins.
export const COUNTRIES: readonly { code: string; name: string; dial: string }[] = [
  { code: "US", name: "United States", dial: "1" },
  { code: "CA", name: "Canada", dial: "1" },
  { code: "MX", name: "México", dial: "52" },
  { code: "GB", name: "United Kingdom", dial: "44" },
  { code: "ES", name: "España", dial: "34" },
  { code: "FR", name: "France", dial: "33" },
  { code: "DE", name: "Deutschland", dial: "49" },
  { code: "IT", name: "Italia", dial: "39" },
  { code: "PT", name: "Portugal", dial: "351" },
  { code: "BR", name: "Brasil", dial: "55" },
];

/** A number as typed, in E.164 (`+15551234567`), or null when it can't be one. */
export function toE164(dial: string, typed: string): string | null {
  const t = typed.trim();
  const digits = t.replace(/\D/g, "");
  const full = t.startsWith("+") ? digits : `${dial}${digits.replace(/^0+/, "")}`;
  return /^[1-9]\d{6,14}$/.test(full) ? `+${full}` : null;
}

/** A code as typed: spaces and dashes dropped. */
export function cleanCode(typed: string): string {
  return typed.replace(/[\s-]/g, "");
}

/** The authenticator key from an `otpauth://` link, in groups of four for typing. */
export function otpSecret(uri: string): string | null {
  try {
    const secret = new URL(uri).searchParams.get("secret");
    return secret ? (secret.match(/.{1,4}/g) ?? [secret]).join(" ") : null;
  } catch {
    return null;
  }
}

type View =
  | { kind: "choose" }
  | { kind: "totp-setup"; otpauthUri: string | null }
  | { kind: "phone-setup"; method: "sms" | "whatsapp" }
  | { kind: "code"; method: SecondFactorKind; phoneHint: string | null; sent: boolean }
  | { kind: "recovery" }
  | { kind: "saved"; codes: string[] };

/** A full page load (an object, so a test can watch it: jsdom can't navigate). */
export const fullPageLoad = { to: (url: string) => window.location.replace(url) };

export function SecondStepScreen() {
  const { t } = useI18n();
  const api = useApiClient();
  const { refresh, signOut } = useSessionState();
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = new URLSearchParams(location.search).get("return_to");
  const [status, setStatus] = useState<SecondFactorStatus | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [view, setView] = useState<View | null>(null);

  async function finish() {
    // §1.116: a sign-in for the phone app goes on to the API's handoff, a full page load (not one
    // of the app's pages), which hands the session to the phone.
    if (returnTo === apiRoutes.mobileHandoff.path) {
      fullPageLoad.to(returnTo);
      return;
    }
    const next = await refresh();
    const home = next.status === "signed_in" ? homeFor(next.session) : "/";
    navigate(safeReturnTo(returnTo, home), { replace: true });
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: asked once, when the page opens.
  useEffect(() => {
    let live = true;
    api
      .call(apiRoutes.secondFactorStatus)
      .then((s) => {
        if (!live) return;
        setStatus(s);
        // Not waiting on a step (already done, exempt, or the step is off): on to the app.
        if (s.state !== "pending") {
          void finish();
          return;
        }
        setView(firstView(s));
      })
      .catch((e) => {
        if (live) setLoadError(e);
      });
    return () => {
      live = false;
    };
  }, []);

  if (loadError) {
    return (
      <SignInFrame>
        <ErrorNotice error={loadError} />
        <SignOutLink onSignOut={signOut} />
      </SignInFrame>
    );
  }
  if (!status || !view) {
    return (
      <SignInFrame>
        <Loading />
      </SignInFrame>
    );
  }

  return (
    <SignInFrame>
      <div data-testid="second-step" data-view={view.kind}>
        <p className="eyebrow text-ink-muted">{t("secondStep.eyebrow")}</p>
        {view.kind === "choose" ? (
          <ChooseMethod status={status} onChosen={(_method, setup) => setView(setup)} />
        ) : view.kind === "totp-setup" ? (
          <TotpSetup
            otpauthUri={view.otpauthUri}
            onPassed={(codes) => (codes ? setView({ kind: "saved", codes }) : void finish())}
          />
        ) : view.kind === "phone-setup" ? (
          <PhoneSetup
            method={view.method}
            onSent={(phoneHint) =>
              setView({ kind: "code", method: view.method, phoneHint, sent: true })
            }
            onBack={() => setView({ kind: "choose" })}
          />
        ) : view.kind === "code" ? (
          <EnterCode
            key={view.method}
            method={view.method}
            phoneHint={view.phoneHint}
            sent={view.sent}
            setup={status.setupNeeded}
            others={verified(status).filter((m) => m.kind !== view.method)}
            onOther={(m) =>
              setView({ kind: "code", method: m.kind, phoneHint: m.phoneHint, sent: false })
            }
            onRecovery={
              status.setupNeeded || status.recoveryCodesLeft === 0
                ? null
                : () => setView({ kind: "recovery" })
            }
            onPassed={(codes) => (codes ? setView({ kind: "saved", codes }) : void finish())}
          />
        ) : view.kind === "recovery" ? (
          <UseRecovery onBack={() => setView(firstView(status))} onPassed={() => void finish()} />
        ) : (
          <SaveRecoveryCodes codes={view.codes} onDone={() => void finish()} />
        )}
        {view.kind !== "saved" ? <SignOutLink onSignOut={signOut} /> : null}
      </div>
    </SignInFrame>
  );
}

function verified(status: SecondFactorStatus): SecondFactorMethodView[] {
  return status.methods.filter((m) => m.verified && status.allowed.includes(m.kind));
}

/** Where the page starts: choose a method to set up, or enter a code from one already set up. */
function firstView(status: SecondFactorStatus): View {
  const methods = verified(status);
  const first = methods.find((m) => m.kind === "totp") ?? methods[0];
  if (status.setupNeeded || !first) return { kind: "choose" };
  return { kind: "code", method: first.kind, phoneHint: first.phoneHint, sent: false };
}

function ChooseMethod({
  status,
  onChosen,
}: {
  status: SecondFactorStatus;
  onChosen: (method: SecondFactorKind, view: View) => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const api = useApiClient();
  const [method, setMethod] = useState<SecondFactorKind>(status.allowed[0] ?? "totp");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const operatorOnly = status.allowed.length === 1 && status.allowed[0] === "totp";

  async function next(e: FormEvent) {
    e.preventDefault();
    if (method !== "totp") {
      onChosen(method, { kind: "phone-setup", method });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.call(apiRoutes.secondFactorSetup, { body: { kind: "totp" } });
      onChosen("totp", { kind: "totp-setup", otpauthUri: res.otpauthUri });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => void next(e)}>
      <h1 className="type-heading text-ink">{t("secondStep.setupTitle")}</h1>
      <p className="text-ink">{t("secondStep.setupIntro")}</p>
      {operatorOnly ? (
        <p className="text-sm text-ink-muted">{t("secondStep.operatorOnly")}</p>
      ) : null}
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="sr-only">{t("secondStep.setupTitle")}</legend>
        {status.allowed.map((kind) => (
          <label
            key={kind}
            className="flex cursor-pointer items-start gap-3 rounded-md border border-line p-3"
            data-testid={`second-step-method-${kind}`}
          >
            <input
              type="radio"
              name="method"
              className="mt-1 size-4 shrink-0 accent-slate"
              checked={method === kind}
              onChange={() => setMethod(kind)}
            />
            <span>
              <span className="block font-medium text-ink">{t(METHOD_LABEL[kind])}</span>
              <span className="block text-sm text-ink-muted">{t(METHOD_HINT[kind])}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {error ? <p className="ds-error text-sm">{errorText(error, i18n)}</p> : null}
      <Button type="submit" variant="primary" disabled={busy} data-testid="second-step-continue">
        {t("secondStep.continue")}
      </Button>
    </form>
  );
}

function TotpSetup({
  otpauthUri,
  onPassed,
}: {
  otpauthUri: string | null;
  onPassed: (codes: string[] | null) => void;
}) {
  const { t } = useI18n();
  const secret = useMemo(() => (otpauthUri ? otpSecret(otpauthUri) : null), [otpauthUri]);
  return (
    <div className="flex flex-col gap-4">
      <h1 className="type-heading text-ink">{t("secondStep.totp.title")}</h1>
      <p className="text-ink">{t("secondStep.totp.step1")}</p>
      {secret ? (
        <div className="rounded-md border border-line p-3">
          <p className="text-sm text-ink-muted">{t("secondStep.totp.key")}</p>
          <p
            className="mt-1 font-mono text-base break-all text-ink select-all"
            data-testid="second-step-secret"
          >
            {secret}
          </p>
        </div>
      ) : null}
      {otpauthUri ? (
        <a
          href={otpauthUri}
          className="text-sm text-link hover:underline"
          data-testid="second-step-open-app"
        >
          {t("secondStep.totp.openApp")}
        </a>
      ) : null}
      <p className="text-ink">{t("secondStep.totp.step2")}</p>
      <CodeForm method="totp" setup onPassed={onPassed} />
    </div>
  );
}

function PhoneSetup({
  method,
  onSent,
  onBack,
}: {
  method: "sms" | "whatsapp";
  onSent: (phoneHint: string | null) => void;
  onBack: () => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const api = useApiClient();
  const [country, setCountry] = useState("US");
  const [number, setNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const dial = COUNTRIES.find((c) => c.code === country)?.dial ?? "1";

  async function send(e: FormEvent) {
    e.preventDefault();
    const phone = toE164(dial, number);
    if (!phone) {
      setProblem(t("secondStep.phone.invalid"));
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const res = await api.call(apiRoutes.secondFactorSetup, { body: { kind: method, phone } });
      onSent(res.phoneHint);
    } catch (err) {
      setProblem(errorText(err, i18n));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => void send(e)}>
      <h1 className="type-heading text-ink">{t(METHOD_LABEL[method])}</h1>
      <Field label={t("secondStep.phone.country")}>
        <Select
          value={country}
          onChange={(e) => setCountry(e.target.value)}
          data-testid="second-step-country"
        >
          {COUNTRIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name} (+{c.dial})
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label={t("secondStep.phone.number")}
        hint={t("secondStep.phone.hint")}
        error={problem ?? undefined}
        testId="second-step-phone"
      >
        <TextInput
          type="tel"
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          autoComplete="tel-national"
          inputMode="tel"
          required
          invalid={!!problem}
          data-testid="second-step-phone"
        />
      </Field>
      <Button type="submit" variant="primary" disabled={busy} data-testid="second-step-send">
        {t("secondStep.phone.send")}
      </Button>
      <button type="button" className="text-sm text-link hover:underline" onClick={onBack}>
        {t("secondStep.otherMethod")}
      </button>
    </form>
  );
}

function EnterCode({
  method,
  phoneHint,
  sent,
  setup,
  others,
  onOther,
  onRecovery,
  onPassed,
}: {
  method: SecondFactorKind;
  phoneHint: string | null;
  sent: boolean;
  setup: boolean;
  others: SecondFactorMethodView[];
  onOther: (m: SecondFactorMethodView) => void;
  onRecovery: (() => void) | null;
  onPassed: (codes: string[] | null) => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const api = useApiClient();
  const [hasSent, setHasSent] = useState(sent);
  const [notice, setNotice] = useState<string | null>(null);
  const [sendError, setSendError] = useState<unknown>(null);
  const [sending, setSending] = useState(false);
  const phone = method !== "totp";

  async function send() {
    if (method === "totp") return;
    setSending(true);
    setSendError(null);
    try {
      const res = await api.call(apiRoutes.secondFactorSend, { body: { kind: method } });
      setNotice(hasSent ? t("secondStep.sent", { phone: res.phoneHint }) : null);
      setHasSent(true);
    } catch (err) {
      setSendError(err);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="type-heading text-ink">{t("secondStep.title")}</h1>
      {phone && !hasSent ? (
        <>
          <p className="text-ink">
            {t(METHOD_LABEL[method])}
            {phoneHint ? ` · ${phoneHint}` : ""}
          </p>
          {sendError ? <p className="ds-error text-sm">{errorText(sendError, i18n)}</p> : null}
          <Button
            variant="primary"
            disabled={sending}
            onClick={() => void send()}
            data-testid="second-step-send"
          >
            {t("secondStep.phone.send")}
          </Button>
        </>
      ) : (
        <>
          <p className="text-ink">{t("secondStep.intro")}</p>
          {notice ? (
            <p className="text-sm text-ink-muted" role="status">
              {notice}
            </p>
          ) : null}
          <CodeForm
            method={method}
            setup={setup}
            hint={
              phone
                ? t("secondStep.code.hintSent", { phone: phoneHint ?? "" })
                : t("secondStep.code.hintApp")
            }
            onPassed={onPassed}
          />
          {phone ? (
            <button
              type="button"
              className="text-left text-sm text-link hover:underline"
              disabled={sending}
              onClick={() => void send()}
              data-testid="second-step-resend"
            >
              {t("secondStep.resend")}
            </button>
          ) : null}
          {sendError ? <p className="ds-error text-sm">{errorText(sendError, i18n)}</p> : null}
        </>
      )}
      {others.length > 0 ? (
        <div className="flex flex-col gap-1">
          {others.map((m) => (
            <button
              key={m.kind}
              type="button"
              className="text-left text-sm text-link hover:underline"
              onClick={() => onOther(m)}
              data-testid={`second-step-other-${m.kind}`}
            >
              {t("secondStep.otherMethod")}: {t(METHOD_LABEL[m.kind])}
            </button>
          ))}
        </div>
      ) : null}
      {onRecovery ? (
        <button
          type="button"
          className="text-left text-sm text-link hover:underline"
          onClick={onRecovery}
          data-testid="second-step-use-recovery"
        >
          {t("secondStep.useRecovery")}
        </button>
      ) : null}
      {!setup ? <p className="text-sm text-ink-muted">{t("secondStep.lost")}</p> : null}
    </div>
  );
}

/** The code and "remember this browser"; finishes the sign-in (and a setup) on the server. */
function CodeForm({
  method,
  setup,
  hint,
  onPassed,
}: {
  method: SecondFactorKind;
  setup: boolean;
  hint?: string;
  onPassed: (codes: string[] | null) => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const api = useApiClient();
  const [code, setCode] = useState("");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function verify(e: FormEvent) {
    e.preventDefault();
    const clean = cleanCode(code);
    if (!/^\d{6,8}$/.test(clean)) {
      setProblem(t("secondStep.code.invalid"));
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const res = await api.call(apiRoutes.secondFactorVerify, {
        body: { kind: method, code: clean, remember },
      });
      onPassed(setup ? (res.recoveryCodes ?? null) : null);
    } catch (err) {
      setProblem(errorText(err, i18n));
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => void verify(e)}>
      <Field
        label={t("secondStep.code.label")}
        hint={hint}
        error={problem ?? undefined}
        testId="second-step-code"
      >
        <TextInput
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="one-time-code"
          inputMode="numeric"
          autoFocus
          required
          invalid={!!problem}
          data-testid="second-step-code"
        />
      </Field>
      <label className="flex items-center gap-3 text-sm text-ink">
        <input
          type="checkbox"
          className="size-4 shrink-0 accent-slate"
          checked={remember}
          onChange={(e) => setRemember(e.target.checked)}
          data-testid="second-step-remember"
        />
        {t("secondStep.remember")}
      </label>
      <Button type="submit" variant="primary" disabled={busy} data-testid="second-step-verify">
        {t("secondStep.verify")}
      </Button>
    </form>
  );
}

function UseRecovery({ onBack, onPassed }: { onBack: () => void; onPassed: () => void }) {
  const i18n = useI18n();
  const { t } = i18n;
  const api = useApiClient();
  const [code, setCode] = useState("");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [left, setLeft] = useState<number | null>(null);

  async function use(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      const res = await api.call(apiRoutes.secondFactorRecovery, {
        body: { code: code.trim(), remember },
      });
      setLeft(res.recoveryCodesLeft);
    } catch (err) {
      setProblem(errorText(err, i18n));
      setBusy(false);
    }
  }

  if (left !== null) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-ink" role="status" data-testid="second-step-recovery-left">
          {t("secondStep.recoveryLow", { count: left })}
        </p>
        <p className="text-sm text-ink-muted">{t("secondStep.lost")}</p>
        <Button variant="primary" onClick={onPassed} data-testid="second-step-recovery-continue">
          {t("secondStep.continue")}
        </Button>
      </div>
    );
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => void use(e)}>
      <h1 className="type-heading text-ink">{t("secondStep.recovery.title")}</h1>
      <Field
        label={t("secondStep.recovery.label")}
        hint={t("secondStep.recovery.hint")}
        error={problem ?? undefined}
        testId="second-step-recovery"
      >
        <TextInput
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          required
          invalid={!!problem}
          data-testid="second-step-recovery"
        />
      </Field>
      <label className="flex items-center gap-3 text-sm text-ink">
        <input
          type="checkbox"
          className="size-4 shrink-0 accent-slate"
          checked={remember}
          onChange={(e) => setRemember(e.target.checked)}
        />
        {t("secondStep.remember")}
      </label>
      <Button
        type="submit"
        variant="primary"
        disabled={busy}
        data-testid="second-step-recovery-use"
      >
        {t("secondStep.recovery.use")}
      </Button>
      <button
        type="button"
        className="text-left text-sm text-link hover:underline"
        onClick={onBack}
      >
        {t("secondStep.recovery.back")}
      </button>
    </form>
  );
}

/** The recovery codes, once: copy, download, then on. They are never shown again. */
function SaveRecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { t } = useI18n();
  const text = codes.join("\n");

  function download() {
    const blob = new Blob([`Mezonas recovery codes\n\n${text}\n`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "mezonas-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-4" data-testid="second-step-saved">
      <h1 className="type-heading text-ink">{t("secondStep.recovery.savedTitle")}</h1>
      <p className="text-ink">{t("secondStep.recovery.savedIntro")}</p>
      <ol
        className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-md border border-line p-4 font-mono text-ink select-all"
        aria-label={t("secondStep.recovery.label")}
        data-testid="second-step-codes"
        data-count={codes.length || RECOVERY_CODE_COUNT}
      >
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ol>
      <Button onClick={download} data-testid="second-step-download">
        {t("secondStep.recovery.download")}
      </Button>
      <Button variant="primary" onClick={onDone} data-testid="second-step-saved-continue">
        {t("secondStep.recovery.confirm")}
      </Button>
    </div>
  );
}

function SignOutLink({ onSignOut }: { onSignOut: () => Promise<void> }) {
  const { t } = useI18n();
  return (
    <p className="mt-6 text-center text-sm">
      <button
        type="button"
        className="text-ink-muted hover:text-ink hover:underline"
        onClick={() => void onSignOut()}
        data-testid="second-step-sign-out"
      >
        {t("secondStep.signOut")}
      </button>
    </p>
  );
}
