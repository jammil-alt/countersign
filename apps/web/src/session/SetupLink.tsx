// `/sign-in/setup/:token` (owner, 2026-11-19; docs/plan.md §1.100): the page the emailed setup
// link opens, with no session. The person adds a text number and/or an authenticator app, each
// proved with one code, saves the recovery codes shown once with the first, then goes back to
// sign in. The link signs nobody in: the sign-in page asks for a code from what was set up here.
import { type SecondFactorKind, type SetupLinkStatus, setupLinkPagePath } from "@countersign/core";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { apiRoutes } from "../api/routes";
import { useApiClient } from "../api/useApi";
import { errorText } from "../i18n/errors";
import { useI18n } from "../i18n/i18n";
import { Field, Select, TextInput } from "../ui/forms";
import { Button, buttonClass, ErrorNotice, Loading } from "../ui/primitives";
import {
  COUNTRIES,
  cleanCode,
  METHOD_HINT,
  METHOD_LABEL,
  otpSecret,
  QrCode,
  SaveRecoveryCodes,
  toE164,
} from "./SecondStep";
import { SignInFrame } from "./SignIn";

type Stage =
  | { kind: "list" }
  | { kind: "number"; method: "sms" | "whatsapp" }
  | { kind: "code"; method: SecondFactorKind; otpauthUri: string | null; phoneHint: string | null }
  | { kind: "saved"; codes: string[] };

/** Where the link's page sends the person when they're done: the sign-in. */
export const BACK_TO_SIGN_IN = "/";

export function SetupLinkScreen() {
  const { t } = useI18n();
  const api = useApiClient();
  const { token = "" } = useParams();
  const [status, setStatus] = useState<SetupLinkStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [stage, setStage] = useState<Stage>({ kind: "list" });

  const load = useCallback(async () => {
    try {
      setStatus(await api.call(apiRoutes.setupLinkStatus, { params: { token } }));
    } catch (err) {
      setError(err);
    }
  }, [api, token]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <SignInFrame>
        <ErrorNotice error={error} />
        <a href={BACK_TO_SIGN_IN} className="mt-4 block text-sm text-link hover:underline">
          {t("setupLink.backToSignIn")}
        </a>
      </SignInFrame>
    );
  }
  if (!status) {
    return (
      <SignInFrame>
        <Loading />
      </SignInFrame>
    );
  }

  const done = (k: SecondFactorKind) => status.methods.some((m) => m.kind === k && m.verified);
  const anyDone = status.methods.some((m) => m.verified);

  return (
    <SignInFrame>
      <div className="flex flex-col gap-4" data-testid="setup-link" data-stage={stage.kind}>
        <p className="eyebrow text-ink-muted">{t("secondStep.eyebrow")}</p>
        {stage.kind === "list" ? (
          <>
            <h1 className="type-heading text-ink">{t("setupLink.title")}</h1>
            <p className="text-ink">{t("setupLink.intro", { email: status.emailHint })}</p>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {status.allowed.map((kind) => (
                <li
                  key={kind}
                  className="flex items-center justify-between gap-3 rounded-md border border-line p-3"
                  data-testid={`setup-link-method-${kind}`}
                >
                  <span>
                    <span className="block font-medium text-ink">{t(METHOD_LABEL[kind])}</span>
                    <span className="block text-sm text-ink-muted">{t(METHOD_HINT[kind])}</span>
                  </span>
                  {done(kind) ? (
                    <span className="text-sm text-positive" data-testid={`setup-link-done-${kind}`}>
                      {t("setupLink.done")}
                    </span>
                  ) : (
                    <StartMethod
                      kind={kind}
                      token={token}
                      onNumber={(method) => setStage({ kind: "number", method })}
                      onCode={(otpauthUri) =>
                        setStage({ kind: "code", method: kind, otpauthUri, phoneHint: null })
                      }
                    />
                  )}
                </li>
              ))}
            </ul>
            {anyDone ? (
              <a
                href={BACK_TO_SIGN_IN}
                className={buttonClass("primary", "text-center")}
                data-testid="setup-link-back"
              >
                {t("setupLink.backToSignIn")}
              </a>
            ) : null}
          </>
        ) : stage.kind === "number" ? (
          <NumberForm
            token={token}
            method={stage.method}
            onSent={(phoneHint) =>
              setStage({ kind: "code", method: stage.method, otpauthUri: null, phoneHint })
            }
            onBack={() => setStage({ kind: "list" })}
          />
        ) : stage.kind === "code" ? (
          <CodeStep
            token={token}
            method={stage.method}
            otpauthUri={stage.otpauthUri}
            phoneHint={stage.phoneHint}
            onBack={() => setStage({ kind: "list" })}
            onVerified={(codes) => {
              void load();
              setStage(codes ? { kind: "saved", codes } : { kind: "list" });
            }}
          />
        ) : (
          <SaveRecoveryCodes codes={stage.codes} onDone={() => setStage({ kind: "list" })} />
        )}
      </div>
    </SignInFrame>
  );
}

function StartMethod({
  kind,
  token,
  onNumber,
  onCode,
}: {
  kind: SecondFactorKind;
  token: string;
  onNumber: (method: "sms" | "whatsapp") => void;
  onCode: (otpauthUri: string | null) => void;
}) {
  const i18n = useI18n();
  const api = useApiClient();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function start() {
    if (kind !== "totp") {
      onNumber(kind);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const res = await api.call(apiRoutes.setupLinkSetup, {
        params: { token },
        body: { kind: "totp" },
      });
      onCode(res.otpauthUri);
    } catch (err) {
      setProblem(errorText(err, i18n));
      setBusy(false);
    }
  }

  return (
    <span className="flex flex-col items-end gap-1">
      <Button onClick={() => void start()} disabled={busy} data-testid={`setup-link-start-${kind}`}>
        {i18n.t("setupLink.setUp")}
      </Button>
      {problem ? <span className="ds-error text-sm">{problem}</span> : null}
    </span>
  );
}

function NumberForm({
  token,
  method,
  onSent,
  onBack,
}: {
  token: string;
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
      const res = await api.call(apiRoutes.setupLinkSetup, {
        params: { token },
        body: { kind: method, phone },
      });
      onSent(res.phoneHint);
    } catch (err) {
      setProblem(errorText(err, i18n));
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => void send(e)}>
      <h1 className="type-heading text-ink">{t(METHOD_LABEL[method])}</h1>
      <Field label={t("secondStep.phone.country")}>
        <Select value={country} onChange={(e) => setCountry(e.target.value)}>
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
        testId="setup-link-phone"
      >
        <TextInput
          type="tel"
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          autoComplete="tel-national"
          inputMode="tel"
          required
          invalid={!!problem}
          data-testid="setup-link-phone"
        />
      </Field>
      <Button type="submit" variant="primary" disabled={busy} data-testid="setup-link-send">
        {t("secondStep.phone.send")}
      </Button>
      <button type="button" className="text-sm text-link hover:underline" onClick={onBack}>
        {t("setupLink.back")}
      </button>
    </form>
  );
}

function CodeStep({
  token,
  method,
  otpauthUri,
  phoneHint,
  onBack,
  onVerified,
}: {
  token: string;
  method: SecondFactorKind;
  otpauthUri: string | null;
  phoneHint: string | null;
  onBack: () => void;
  onVerified: (codes: string[] | null) => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const api = useApiClient();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const secret = useMemo(() => (otpauthUri ? otpSecret(otpauthUri) : null), [otpauthUri]);

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
      const res = await api.call(apiRoutes.setupLinkVerify, {
        params: { token },
        body: { kind: method, code: clean },
      });
      onVerified(res.recoveryCodes);
    } catch (err) {
      setProblem(errorText(err, i18n));
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => void verify(e)}>
      <h1 className="type-heading text-ink">
        {method === "totp" ? t("secondStep.totp.title") : t(METHOD_LABEL[method])}
      </h1>
      {otpauthUri ? (
        <>
          <p className="text-ink">{t("secondStep.totp.step1")}</p>
          <QrCode text={otpauthUri} label={t("secondStep.totp.qr")} />
          {secret ? (
            <div className="rounded-md border border-line p-3">
              <p className="text-sm text-ink-muted">{t("secondStep.totp.key")}</p>
              <p className="mt-1 font-mono text-base break-all text-ink select-all">{secret}</p>
            </div>
          ) : null}
          <a href={otpauthUri} className="text-sm text-link hover:underline">
            {t("secondStep.totp.openApp")}
          </a>
          <p className="text-ink">{t("secondStep.totp.step2")}</p>
        </>
      ) : null}
      <Field
        label={t("secondStep.code.label")}
        hint={
          method === "totp"
            ? t("secondStep.code.hintApp")
            : t("secondStep.code.hintSent", { phone: phoneHint ?? "" })
        }
        error={problem ?? undefined}
        testId="setup-link-code"
      >
        <TextInput
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="one-time-code"
          inputMode="numeric"
          required
          invalid={!!problem}
          data-testid="setup-link-code"
        />
      </Field>
      <Button type="submit" variant="primary" disabled={busy} data-testid="setup-link-verify">
        {t("secondStep.verify")}
      </Button>
      <button type="button" className="text-sm text-link hover:underline" onClick={onBack}>
        {t("setupLink.back")}
      </button>
    </form>
  );
}

/** The route table's path for this page (core `setupLinkPagePath`). */
export const SETUP_LINK_ROUTE = setupLinkPagePath(":token");
