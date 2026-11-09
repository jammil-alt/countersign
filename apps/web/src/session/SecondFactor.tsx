// The second step of signing in (docs/plan.md §1.83), shown in place of the app while the session
// is pending (`second_factor_required`). The first time, the person picks a method (operators: the
// authenticator app only), proves it with one code and is shown their recovery codes once. Later,
// they enter a code from the method they set up, or a recovery code. The API checks every code; this
// screen only asks for them. In the browser's language, like the sign-in page.
import {
  RecoveryCodeInput,
  SECOND_FACTOR_METHODS,
  SECOND_FACTOR_PENDING_SEC,
  SECOND_FACTOR_WINDOW_MIN,
  type SecondFactorMethod,
  type SecondFactorState,
} from "@countersign/core";
import { type FormEvent, lazy, type ReactNode, Suspense, useEffect, useState } from "react";
import { isApiError } from "../api/client";
import { apiRoutes } from "../api/routes";
import { useApi, useApiClient } from "../api/useApi";
import type { PlainKey } from "../i18n/catalog";
import { errorText } from "../i18n/errors";
import { browserLanguages, type I18n, useI18n } from "../i18n/i18n";
import { PRODUCT_NAME } from "../ui/brand";
import { Field, Select, TextInput } from "../ui/forms";
import { Icon, type IconName } from "../ui/icons";
import { Button, ErrorNotice, Loading } from "../ui/primitives";
import { defaultPhoneCountry, phoneCountryOptions, phoneToE164 } from "./phone";
import { SignInFrame } from "./SignIn";
import { useSessionState } from "./session";

/** Its own chunk: only someone setting up an authenticator app needs the QR code drawn. */
const QrCode = lazy(() => import("./QrCode"));

type PhoneMethod = Exclude<SecondFactorMethod, "totp">;
type Mode = SecondFactorMethod | "recovery";
type Verified = (recoveryCodes: string[] | null) => void;
/** Whether the error ended the step (the 10 minutes ran out); the screen then says so. */
type OnError = (error: unknown) => boolean;

const METHOD: Record<SecondFactorMethod, { name: PlainKey; help: PlainKey; icon: IconName }> = {
  totp: {
    name: "secondFactor.method.totp",
    help: "secondFactor.method.totp.help",
    icon: "phone",
  },
  sms: { name: "secondFactor.method.sms", help: "secondFactor.method.sms.help", icon: "message" },
  whatsapp: {
    name: "secondFactor.method.whatsapp",
    help: "secondFactor.method.whatsapp.help",
    icon: "message",
  },
};

const USE_INSTEAD: Record<Mode, PlainKey> = {
  totp: "secondFactor.use.totp",
  sms: "secondFactor.use.sms",
  whatsapp: "secondFactor.use.whatsapp",
  recovery: "secondFactor.use.recovery",
};

/** The session is gone: the 10 minutes ran out, or the cookie is no longer good. */
function endedStep(error: unknown): boolean {
  return (
    isApiError(error) &&
    (error.status === 401 ||
      error.code === "second_factor_expired" ||
      error.code === "session_invalid")
  );
}

/** What a refused step says, in plain words. */
export function secondFactorProblem(error: unknown, i18n: I18n): string {
  const { t } = i18n;
  switch (isApiError(error) ? error.code : null) {
    case "wrong_code":
      return t("secondFactor.error.wrong_code");
    case "too_many_attempts":
      return t("secondFactor.error.too_many_attempts", { minutes: SECOND_FACTOR_WINDOW_MIN });
    case "not_available":
      return t("secondFactor.error.not_available");
    case "operator_needs_authenticator":
      return t("secondFactor.error.operator");
    default:
      return errorText(error, i18n);
  }
}

export function SecondFactorScreen() {
  const { t } = useI18n();
  const { refresh, signOut, restart } = useSessionState();
  const state = useApi(apiRoutes.secondFactorState);
  const [ended, setEnded] = useState(false);
  // Shown once, then gone: kept only here, never stored.
  const [codes, setCodes] = useState<string[] | null>(null);

  const onError: OnError = (error) => {
    if (!endedStep(error)) return false;
    setEnded(true);
    return true;
  };
  const onVerified: Verified = (recoveryCodes) => {
    if (recoveryCodes && recoveryCodes.length > 0) setCodes(recoveryCodes);
    else void refresh();
  };

  let body: ReactNode;
  if (ended || endedStep(state.error)) {
    body = <Ended onRestart={restart} />;
  } else if (codes) {
    body = <RecoveryCodes codes={codes} onContinue={() => void refresh()} />;
  } else if (state.data) {
    body =
      state.data.status === "pending" ? (
        <Step state={state.data} onVerified={onVerified} onError={onError} />
      ) : (
        // Already passed, or not asked of this person: load the session.
        <Refresh />
      );
  } else if (state.error) {
    body = <ErrorNotice error={state.error} onRetry={state.reload} />;
  } else {
    body = <Loading />;
  }

  return (
    <SignInFrame
      footer={
        <button
          type="button"
          className="text-sm text-link hover:underline"
          data-testid="second-factor-sign-out"
          onClick={() => {
            signOut().catch(() => {});
          }}
        >
          {t("shell.signOut")}
        </button>
      }
    >
      <div data-testid="second-factor">{body}</div>
    </SignInFrame>
  );
}

function Refresh() {
  const { refresh } = useSessionState();
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return <Loading />;
}

function Step({
  state,
  onVerified,
  onError,
}: {
  state: SecondFactorState;
  onVerified: Verified;
  onError: OnError;
}) {
  // An operator's phone method from before can't be used (§1.83): only allowed methods count.
  const verified = state.methods
    .filter((m) => m.verified && state.allowed.includes(m.method))
    .map((m) => ({ method: m.method, phoneHint: m.phoneHint }));
  if (verified.length > 0) {
    return (
      <SignInStep state={state} verified={verified} onVerified={onVerified} onError={onError} />
    );
  }
  return <SetupStep state={state} onVerified={onVerified} onError={onError} />;
}

// ── Setting up (the first sign-in) ─────────────────────────────────────────────────────────────

function SetupStep({
  state,
  onVerified,
  onError,
}: {
  state: SecondFactorState;
  onVerified: Verified;
  onError: OnError;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const api = useApiClient();
  const choices = SECOND_FACTOR_METHODS.filter(
    (m) => state.allowed.includes(m) && state.available[m],
  );
  const [picked, setPicked] = useState<SecondFactorMethod | null>(null);
  const [totp, setTotp] = useState<{ uri: string; secret: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);

  async function pick(method: SecondFactorMethod) {
    setProblem(null);
    if (method !== "totp") {
      setPicked(method);
      return;
    }
    setBusy(true);
    try {
      setTotp(await api.call(apiRoutes.secondFactorTotpStart));
      setPicked("totp");
    } catch (error) {
      if (!onError(error)) setProblem(error);
    } finally {
      setBusy(false);
    }
  }

  const back =
    choices.length > 1 ? (
      <Button
        variant="link"
        data-testid="second-factor-other-method"
        onClick={() => {
          setPicked(null);
          setTotp(null);
        }}
      >
        {t("secondFactor.setup.other")}
      </Button>
    ) : null;

  if (picked === "totp" && totp) {
    return (
      <TotpSetup
        uri={totp.uri}
        secret={totp.secret}
        onVerified={onVerified}
        onError={onError}
        back={back}
      />
    );
  }
  if (picked === "sms" || picked === "whatsapp") {
    return <PhoneSetup method={picked} onVerified={onVerified} onError={onError} back={back} />;
  }

  return (
    <div data-testid="second-factor-setup">
      <h1 className="type-heading text-ink">{t("secondFactor.setup.title")}</h1>
      <p className="mt-1 text-ink-muted">{t("secondFactor.setup.help")}</p>
      {state.operator ? (
        <p className="mt-2 text-sm text-ink-muted" data-testid="second-factor-operator">
          {t("secondFactor.setup.operator")}
        </p>
      ) : null}
      {choices.length === 0 ? (
        <div className="mt-5">
          <ErrorNotice error={new Error(t("secondFactor.setup.none"))} />
        </div>
      ) : (
        <ul className="mt-5 overflow-hidden rounded-md border border-line">
          {choices.map((m) => (
            <li key={m} className="border-b border-line last:border-b-0">
              <button
                type="button"
                data-testid={`second-factor-pick-${m}`}
                disabled={busy}
                onClick={() => void pick(m)}
                className="ds-listrow border-b-0 text-left disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className="flex min-w-0 items-center gap-3">
                  <Icon name={METHOD[m].icon} size={20} className="text-ink-muted" />
                  <span className="min-w-0">
                    <span className="ds-listrow__title font-medium text-ink">
                      {t(METHOD[m].name)}
                    </span>
                    <span className="ds-listrow__meta">{t(METHOD[m].help)}</span>
                  </span>
                </span>
                <Icon name="chevron-right" className="text-ink-muted" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <Problem error={problem} />
    </div>
  );
}

function TotpSetup({
  uri,
  secret,
  onVerified,
  onError,
  back,
}: {
  uri: string;
  secret: string;
  onVerified: Verified;
  onError: OnError;
  back: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div data-testid="second-factor-totp-setup">
      <h1 className="type-heading text-ink">{t("secondFactor.totp.title")}</h1>
      <ol className="mt-5 flex flex-col gap-5">
        <li>
          <p className="text-ink">{t("secondFactor.totp.scan")}</p>
          <div className="mt-3">
            <Suspense fallback={<div className="size-44 rounded-sm border border-line" />}>
              <QrCode value={uri} alt={t("secondFactor.totp.qrAlt")} />
            </Suspense>
          </div>
        </li>
        <li>
          <p className="text-sm text-ink-muted">{t("secondFactor.totp.manual")}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="sr-only">{t("secondFactor.totp.key")}</span>
            <code
              className="min-w-0 rounded-sm border border-line bg-surface-subtle px-2 py-1 font-mono text-sm break-all text-ink"
              data-testid="second-factor-secret"
            >
              {groupsOfFour(secret)}
            </code>
            <CopyButton value={secret} testId="second-factor-secret-copy" />
          </div>
        </li>
        <li>
          <p className="mb-3 text-ink">{t("secondFactor.totp.enter")}</p>
          <CodeForm method="totp" onVerified={onVerified} onError={onError} />
        </li>
      </ol>
      {back ? <div className="mt-4">{back}</div> : null}
    </div>
  );
}

/** "JBSW Y3DP EHPK 3PXP": easier to type into an app by hand. */
function groupsOfFour(secret: string): string {
  return secret.replace(/\s/g, "").replace(/(.{4})(?=.)/g, "$1 ");
}

function PhoneSetup({
  method,
  onVerified,
  onError,
  back,
}: {
  method: PhoneMethod;
  onVerified: Verified;
  onError: OnError;
  back: ReactNode;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const api = useApiClient();
  const [country, setCountry] = useState(() => defaultPhoneCountry(browserLanguages()));
  const [phone, setPhone] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function send(e: FormEvent) {
    e.preventDefault();
    setProblem(null);
    const e164 = phoneToE164(phone, country);
    setInvalid(e164 === null);
    if (!e164) return;
    setBusy(true);
    try {
      const res = await api.call(apiRoutes.secondFactorPhoneStart, {
        body: { method, phone: e164 },
      });
      setSentTo(res.phoneHint);
    } catch (error) {
      if (!onError(error)) setProblem(error);
    } finally {
      setBusy(false);
    }
  }

  const title =
    method === "sms" ? t("secondFactor.phone.title.sms") : t("secondFactor.phone.title.whatsapp");

  if (sentTo) {
    return (
      <div data-testid="second-factor-phone-setup">
        <h1 className="type-heading text-ink">{title}</h1>
        <p className="mt-1 mb-5 text-ink-muted" role="status" data-testid="second-factor-sent">
          {t("secondFactor.sent", { phone: sentTo })}
        </p>
        <CodeForm method={method} onVerified={onVerified} onError={onError} />
        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2">
          <ResendButton method={method} onError={onError} onSent={setSentTo} />
          <Button
            variant="link"
            data-testid="second-factor-change-number"
            onClick={() => setSentTo(null)}
          >
            {t("secondFactor.changeNumber")}
          </Button>
        </div>
        {back ? <div className="mt-2">{back}</div> : null}
      </div>
    );
  }

  return (
    <div data-testid="second-factor-phone-setup">
      <h1 className="type-heading text-ink">{title}</h1>
      <p className="mt-1 mb-5 text-ink-muted">
        {method === "sms"
          ? t("secondFactor.method.sms.help")
          : t("secondFactor.method.whatsapp.help")}
      </p>
      <form className="flex flex-col gap-4" onSubmit={(e) => void send(e)} noValidate>
        <Field label={t("secondFactor.phone.country")}>
          <Select
            id="second-factor-country"
            data-testid="second-factor-country"
            autoComplete="country"
            value={country}
            onChange={(e) => {
              setCountry(e.target.value);
              setInvalid(false);
            }}
          >
            {phoneCountryOptions(i18n.locale).map((c) => (
              <option key={c.code} value={c.code}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label={t("secondFactor.phone.number")}
          hint={t("secondFactor.phone.hint")}
          error={invalid ? t("secondFactor.phone.invalid") : undefined}
          testId="second-factor-phone"
        >
          <TextInput
            id="second-factor-phone"
            data-testid="second-factor-phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={phone}
            invalid={invalid}
            onChange={(e) => {
              setPhone(e.target.value);
              setInvalid(false);
            }}
          />
        </Field>
        <Button
          type="submit"
          variant="primary"
          className="w-full justify-center"
          disabled={busy || !phone.trim()}
          data-testid="second-factor-phone-send"
        >
          {busy ? t("common.sending") : t("secondFactor.send")}
        </Button>
      </form>
      <Problem error={problem} />
      {back ? <div className="mt-4">{back}</div> : null}
    </div>
  );
}

// ── Signing in (a method is set up) ────────────────────────────────────────────────────────────

function SignInStep({
  state,
  verified,
  onVerified,
  onError,
}: {
  state: SecondFactorState;
  verified: { method: SecondFactorMethod; phoneHint: string | null }[];
  onVerified: Verified;
  onError: OnError;
}) {
  const { t } = useI18n();
  // A text or WhatsApp method the deployment can't send right now stays out of the choices.
  const usable = verified.filter((m) => state.available[m.method]);
  const [mode, setMode] = useState<Mode>(usable[0]?.method ?? "recovery");
  const current = usable.find((m) => m.method === mode);
  const others: Mode[] = [
    ...usable.map((m) => m.method).filter((m) => m !== mode),
    ...(mode === "recovery" ? [] : (["recovery"] as const)),
  ];

  return (
    <div data-testid="second-factor-sign-in">
      <h1 className="type-heading text-ink">
        {mode === "recovery" ? t("secondFactor.use.recovery") : t("secondFactor.signIn.title")}
      </h1>
      {mode === "recovery" ? (
        <RecoveryForm
          key="recovery"
          left={state.recoveryCodesLeft}
          onVerified={onVerified}
          onError={onError}
        />
      ) : mode === "totp" ? (
        <div key="totp">
          <p className="mt-1 mb-5 text-ink-muted">
            {t("secondFactor.signIn.totp", { product: PRODUCT_NAME })}
          </p>
          <CodeForm method="totp" onVerified={onVerified} onError={onError} />
        </div>
      ) : (
        <PhoneSignIn
          key={mode}
          method={mode}
          phoneHint={current?.phoneHint ?? ""}
          onVerified={onVerified}
          onError={onError}
        />
      )}
      {others.length > 0 ? (
        <ul className="mt-5 flex flex-col items-start gap-1 border-t border-line pt-4">
          {others.map((m) => (
            <li key={m}>
              <Button
                variant="link"
                data-testid={`second-factor-use-${m}`}
                onClick={() => setMode(m)}
              >
                {t(USE_INSTEAD[m])}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function PhoneSignIn({
  method,
  phoneHint,
  onVerified,
  onError,
}: {
  method: PhoneMethod;
  phoneHint: string;
  onVerified: Verified;
  onError: OnError;
}) {
  const { t } = useI18n();
  const api = useApiClient();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);

  async function send() {
    setBusy(true);
    setProblem(null);
    try {
      setSentTo((await api.call(apiRoutes.secondFactorSend, { body: { method } })).phoneHint);
    } catch (error) {
      if (!onError(error)) setProblem(error);
    } finally {
      setBusy(false);
    }
  }

  if (sentTo) {
    return (
      <div>
        <p className="mt-1 mb-5 text-ink-muted" role="status" data-testid="second-factor-sent">
          {t("secondFactor.sent", { phone: sentTo })}
        </p>
        <CodeForm method={method} onVerified={onVerified} onError={onError} />
        <div className="mt-4">
          <ResendButton method={method} onError={onError} onSent={setSentTo} />
        </div>
      </div>
    );
  }
  return (
    <div>
      <p className="mt-1 mb-5 text-ink-muted">
        {method === "sms"
          ? t("secondFactor.signIn.sms", { phone: phoneHint })
          : t("secondFactor.signIn.whatsapp", { phone: phoneHint })}
      </p>
      <Button
        variant="primary"
        className="w-full justify-center"
        disabled={busy}
        data-testid="second-factor-send"
        onClick={() => void send()}
      >
        {busy ? t("common.sending") : t("secondFactor.send")}
      </Button>
      <Problem error={problem} />
    </div>
  );
}

function RecoveryForm({
  left,
  onVerified,
  onError,
}: {
  left: number;
  onVerified: Verified;
  onError: OnError;
}) {
  const { t } = useI18n();
  const api = useApiClient();
  const [code, setCode] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setProblem(null);
    const parsed = RecoveryCodeInput.safeParse(code);
    setInvalid(!parsed.success);
    if (!parsed.success) return;
    setBusy(true);
    try {
      const res = await api.call(apiRoutes.secondFactorVerify, {
        body: { method: "recovery", code: parsed.data },
      });
      onVerified(res.recoveryCodes);
    } catch (error) {
      if (!onError(error)) setProblem(error);
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="mt-1 mb-5 text-ink-muted">{t("secondFactor.recovery.help")}</p>
      <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)} noValidate>
        <Field
          label={t("secondFactor.recovery.label")}
          error={invalid ? t("secondFactor.recovery.invalid") : undefined}
          testId="second-factor-recovery"
        >
          <TextInput
            id="second-factor-recovery"
            data-testid="second-factor-recovery"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="abcd-efgh"
            className="font-mono"
            value={code}
            invalid={invalid}
            onChange={(e) => {
              setCode(e.target.value);
              setInvalid(false);
            }}
          />
        </Field>
        <Button
          type="submit"
          variant="primary"
          className="w-full justify-center"
          disabled={busy || !code.trim()}
          data-testid="second-factor-recovery-submit"
        >
          {busy ? t("secondFactor.checking") : t("secondFactor.verify")}
        </Button>
      </form>
      <p className="mt-3 text-sm text-ink-muted" data-testid="second-factor-recovery-left">
        {left > 0
          ? t("secondFactor.recovery.left", { count: left })
          : t("secondFactor.recovery.none")}
      </p>
      <Problem error={problem} />
    </div>
  );
}

// ── Parts ──────────────────────────────────────────────────────────────────────────────────────

/** The code from the app or the message, checked by the API; Verify. */
function CodeForm({
  method,
  onVerified,
  onError,
}: {
  method: SecondFactorMethod;
  onVerified: Verified;
  onError: OnError;
}) {
  const { t } = useI18n();
  const api = useApiClient();
  const [code, setCode] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setProblem(null);
    const digits = code.replace(/[\s-]/g, "");
    // An authenticator app shows 6 digits; Twilio's messages carry 4 to 10.
    const ok = method === "totp" ? /^\d{6}$/.test(digits) : /^\d{4,10}$/.test(digits);
    setInvalid(!ok);
    if (!ok) return;
    setBusy(true);
    try {
      const res = await api.call(apiRoutes.secondFactorVerify, { body: { method, code: digits } });
      onVerified(res.recoveryCodes);
    } catch (error) {
      if (!onError(error)) setProblem(error);
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)} noValidate>
      <Field
        label={t("secondFactor.code")}
        error={invalid ? t("secondFactor.code.invalid") : undefined}
        testId="second-factor-code"
      >
        <TextInput
          id="second-factor-code"
          data-testid="second-factor-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={12}
          className="font-mono tracking-widest"
          value={code}
          invalid={invalid}
          onChange={(e) => {
            setCode(e.target.value);
            setInvalid(false);
          }}
        />
      </Field>
      <Button
        type="submit"
        variant="primary"
        className="w-full justify-center"
        disabled={busy || !code.trim()}
        data-testid="second-factor-verify"
      >
        {busy ? t("secondFactor.checking") : t("secondFactor.verify")}
      </Button>
      <Problem error={problem} />
    </form>
  );
}

function ResendButton({
  method,
  onError,
  onSent,
}: {
  method: PhoneMethod;
  onError: OnError;
  onSent: (phoneHint: string) => void;
}) {
  const { t } = useI18n();
  const api = useApiClient();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  return (
    <>
      <Button
        variant="link"
        disabled={busy}
        data-testid="second-factor-resend"
        onClick={() => {
          setBusy(true);
          setProblem(null);
          api.call(apiRoutes.secondFactorSend, { body: { method } }).then(
            (res) => {
              setBusy(false);
              onSent(res.phoneHint);
            },
            (error: unknown) => {
              setBusy(false);
              if (!onError(error)) setProblem(error);
            },
          );
        }}
      >
        {busy ? t("common.sending") : t("secondFactor.resend")}
      </Button>
      <Problem error={problem} />
    </>
  );
}

/** A refused step, as a risk banner in plain words; the server's code stays on the element. */
function Problem({ error }: { error: unknown }) {
  const i18n = useI18n();
  if (!error) return null;
  return (
    <div
      role="alert"
      className="ds-banner mt-4 w-full items-center"
      data-testid="second-factor-problem"
      {...(isApiError(error) ? { "data-error-code": error.code } : {})}
    >
      <Icon name="alert" className="mt-px" />
      <span className="min-w-0 flex-1">{secondFactorProblem(error, i18n)}</span>
    </div>
  );
}

function CopyButton({ value, testId }: { value: string; testId: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      data-testid={testId}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          },
          () => {},
        );
      }}
    >
      <Icon name="copy" />
      {copied ? t("common.copied") : t("common.copy")}
    </Button>
  );
}

/** The recovery codes, once, right after a method is set up. */
function RecoveryCodes({ codes, onContinue }: { codes: string[]; onContinue: () => void }) {
  const { t } = useI18n();
  const [saved, setSaved] = useState(false);
  const text = `${t("secondFactor.codes.file", { product: PRODUCT_NAME })}\n\n${codes.join("\n")}\n`;
  return (
    <div data-testid="second-factor-codes">
      <h1 className="type-heading text-ink">{t("secondFactor.codes.title")}</h1>
      <p className="mt-1 text-ink-muted">{t("secondFactor.codes.help")}</p>
      <ol
        aria-label={t("secondFactor.codes.list")}
        className="mt-5 grid grid-cols-2 gap-x-6 gap-y-2 rounded-md border border-line bg-surface-subtle px-4 py-3 font-mono text-ink"
        data-testid="second-factor-codes-list"
      >
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ol>
      <div className="mt-3 flex flex-wrap gap-2">
        <CopyButton value={codes.join("\n")} testId="second-factor-codes-copy" />
        <Button
          size="sm"
          data-testid="second-factor-codes-download"
          onClick={() => downloadText(`${PRODUCT_NAME.toLowerCase()}-recovery-codes.txt`, text)}
        >
          <Icon name="upload" className="rotate-180" />
          {t("secondFactor.codes.download")}
        </Button>
      </div>
      <label className="mt-5 flex items-start gap-3">
        <input
          id="second-factor-codes-saved"
          type="checkbox"
          className="mt-1 size-4 accent-slate"
          data-testid="second-factor-codes-saved"
          checked={saved}
          onChange={() => setSaved((v) => !v)}
        />
        <span className="text-ink">{t("secondFactor.codes.saved")}</span>
      </label>
      <Button
        variant="primary"
        className="mt-5 w-full justify-center"
        disabled={!saved}
        data-testid="second-factor-codes-continue"
        onClick={onContinue}
      >
        {t("secondFactor.codes.continue")}
      </Button>
    </div>
  );
}

/** As the audit log's CSV download (ops/screens/AuditLog.tsx): a Blob, never sent anywhere. */
function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function Ended({ onRestart }: { onRestart: () => void }) {
  const { t } = useI18n();
  return (
    <div data-testid="second-factor-ended">
      <h1 className="type-heading text-ink">{t("secondFactor.expired.title")}</h1>
      <p className="mt-1 mb-5 text-ink-muted">
        {t("secondFactor.expired.body", { minutes: Math.round(SECOND_FACTOR_PENDING_SEC / 60) })}
      </p>
      <Button
        variant="primary"
        className="w-full justify-center"
        data-testid="second-factor-sign-in-again"
        onClick={onRestart}
      >
        {t("secondFactor.signInAgain")}
      </Button>
    </div>
  );
}
