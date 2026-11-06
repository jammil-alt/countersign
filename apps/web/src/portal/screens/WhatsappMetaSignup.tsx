// v0.14 W4-A: `/connections/whatsapp_meta/signup`, where the client admin connects the client's own
// WhatsApp Business number with Meta's Embedded Signup (docs/plan.md §1.57). The API answers Meta's
// public values (the app's id, the Embedded Signup configuration's id, the Graph version) and a
// signed state; Meta's JS SDK opens Meta's window, where the admin signs in to Facebook and picks
// the account and number (we never see that login). Meta hands this page a short-lived code, and
// posts the chosen account and number to it as a message from facebook.com (checked by exact
// origin); the page sends both, with the state, to the usual callback route, where the server
// exchanges the code and checks the account and number itself. This page is always loaded as a
// document (never by client-side navigation): only this path's Content-Security-Policy lets Meta's
// script and frames in (apps/web/public/_headers), and it goes back to Connections with a full load.
import { useEffect, useRef, useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApiClient } from "../../api/useApi";
import { useI18n } from "../../i18n/i18n";
import { Button, buttonClass, ErrorNotice, Loading, PageHeader } from "../../ui/primitives";

/** Meta's JS SDK: the only script this page adds. */
export const META_SDK_SCRIPT = "https://connect.facebook.net/en_US/sdk.js";
export const WHATSAPP_META_SIGNUP_PATH = "/connections/whatsapp_meta/signup";
/** Where Meta's session-info message may come from (exact origins). */
export const META_MESSAGE_ORIGINS: ReadonlySet<string> = new Set([
  "https://www.facebook.com",
  "https://web.facebook.com",
]);

interface Link {
  token: string;
  appId?: string | undefined;
  graphVersion?: string | undefined;
  state: string;
}

interface FbLoginResponse {
  authResponse?: { code?: string } | null;
  status?: string;
}
interface FbGlobal {
  init(config: { appId: string; autoLogAppEvents: boolean; xfbml: boolean; version: string }): void;
  login(
    callback: (response: FbLoginResponse) => void,
    options: {
      config_id: string;
      response_type: "code";
      override_default_response_type: true;
      extras: { setup: Record<string, never>; sessionInfoVersion: string };
    },
  ): void;
}
type MetaWindow = Window & { FB?: FbGlobal; fbAsyncInit?: () => void };

/** The account and number Meta's window says were chosen (digits only), or null. */
export function sessionInfoOf(
  origin: string,
  data: unknown,
): { kind: "finish"; wabaId: string; phoneNumberId: string } | { kind: "cancel" } | null {
  if (!META_MESSAGE_ORIGINS.has(origin) || typeof data !== "string" || data.length > 4000) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const m = parsed as { type?: unknown; event?: unknown; data?: unknown };
  if (m.type !== "WA_EMBEDDED_SIGNUP") return null;
  if (m.event === "CANCEL") return { kind: "cancel" };
  if (m.event !== "FINISH" || !m.data || typeof m.data !== "object") return null;
  const d = m.data as { waba_id?: unknown; phone_number_id?: unknown };
  const digits = (v: unknown) =>
    typeof v === "string" &&
    v.length > 0 &&
    v.length <= 32 &&
    [...v].every((c) => c >= "0" && c <= "9");
  return digits(d.waba_id) && digits(d.phone_number_id)
    ? { kind: "finish", wabaId: d.waba_id as string, phoneNumberId: d.phone_number_id as string }
    : null;
}

/** Loads Meta's SDK once and initializes it with our app; resolves with `FB`. */
function loadSdk(link: Link): Promise<FbGlobal> {
  const w = window as MetaWindow;
  if (w.FB) return Promise.resolve(w.FB);
  return new Promise((resolve, reject) => {
    w.fbAsyncInit = () => {
      const fb = w.FB;
      if (!fb || !link.appId || !link.graphVersion) return reject(new Error("Meta's SDK"));
      fb.init({
        appId: link.appId,
        autoLogAppEvents: false,
        xfbml: false,
        version: link.graphVersion,
      });
      resolve(fb);
    };
    const el = document.createElement("script");
    el.src = META_SDK_SCRIPT;
    el.async = true;
    el.defer = true;
    el.crossOrigin = "anonymous";
    el.addEventListener("error", () => reject(new Error("Meta's SDK didn't load")));
    document.head.appendChild(el);
  });
}

/** Back to Connections with a full load, so this page's wider policy goes with it. */
function backToConnections() {
  window.location.assign("/accounts");
}

type Phase = "loading" | "ready" | "signing" | "saving" | "cancelled" | "failed" | "unavailable";

export function WhatsappMetaSignupScreen() {
  const api = useApiClient();
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<unknown>(null);
  const link = useRef<Link | null>(null);
  const fb = useRef<FbGlobal | null>(null);
  const chosen = useRef<{ wabaId: string; phoneNumberId: string } | null>(null);

  useEffect(() => {
    let live = true;
    const onMessage = (event: MessageEvent) => {
      // Only Meta's own windows (META_MESSAGE_ORIGINS, also checked in sessionInfoOf). Spelled
      // out so the guard is plain where the message arrives.
      if (
        event.origin !== "https://www.facebook.com" &&
        event.origin !== "https://web.facebook.com"
      ) {
        return;
      }
      const info = sessionInfoOf(event.origin, event.data);
      if (info?.kind === "finish") chosen.current = info;
      if (info?.kind === "cancel" && live) setPhase("cancelled");
    };
    window.addEventListener("message", onMessage);
    api
      .call(apiRoutes.portalAuthorize, { params: { connector: "whatsapp_meta" } })
      .then(async (res) => {
        const l = res.link;
        if (l?.provider !== "meta") throw new Error("not Meta's sign-up");
        link.current = l;
        fb.current = await loadSdk(l);
        if (live) setPhase("ready");
      })
      .catch((e: unknown) => {
        if (!live) return;
        const code = (e as { code?: string } | null)?.code;
        if (code === "not_available") setPhase("unavailable");
        else {
          setError(e);
          setPhase("failed");
        }
      });
    return () => {
      live = false;
      window.removeEventListener("message", onMessage);
    };
  }, [api]);

  async function finish(code: string, state: string) {
    setPhase("saving");
    // Meta's message with the chosen account and number may come just after the code.
    for (let i = 0; i < 20 && !chosen.current; i++) {
      await new Promise((r) => setTimeout(r, 150));
    }
    const picked = chosen.current;
    try {
      await api.call(apiRoutes.portalAuthorizeCallback, {
        params: { connector: "whatsapp_meta" },
        body: {
          params: {
            code,
            state,
            ...(picked ? { waba_id: picked.wabaId, phone_number_id: picked.phoneNumberId } : {}),
          },
        },
      });
      backToConnections();
    } catch (e) {
      setError(e);
      setPhase("ready");
    }
  }

  // Runs in the click itself: Meta's window is a pop-up, which browsers allow only then.
  function open() {
    const l = link.current;
    const sdk = fb.current;
    if (!l || !sdk) return;
    setPhase("signing");
    setError(null);
    sdk.login(
      (response) => {
        const code = response.authResponse?.code;
        if (code) void finish(code, l.state);
        else setPhase("cancelled");
      },
      {
        config_id: l.token,
        response_type: "code",
        override_default_response_type: true,
        extras: { setup: {}, sessionInfoVersion: "3" },
      },
    );
  }

  return (
    <div>
      <PageHeader
        title={t("whatsappMeta.signup.title")}
        subtitle={t("whatsappMeta.signup.subtitle")}
      />
      {error ? (
        <div className="mb-3">
          <ErrorNotice error={error} />
        </div>
      ) : null}
      <div className="flex flex-col items-start gap-3" data-testid="whatsapp-meta-signup">
        {phase === "unavailable" ? (
          <p className="text-sm text-ink-muted">{t("whatsappMeta.signup.notSetUp")}</p>
        ) : phase === "loading" ? (
          <Loading label={t("whatsappMeta.signup.loading")} />
        ) : phase === "saving" ? (
          <Loading label={t("whatsappMeta.signup.saving")} />
        ) : (
          <>
            {phase === "cancelled" ? (
              <p className="text-sm text-ink-muted">{t("whatsappMeta.signup.cancelled")}</p>
            ) : null}
            {phase === "failed" ? (
              <p role="alert" className="text-sm text-risk-ink">
                {t("whatsappMeta.signup.failed")}
              </p>
            ) : null}
            <Button
              variant="primary"
              data-testid="whatsapp-meta-open"
              disabled={phase === "signing" || phase === "failed"}
              onClick={open}
            >
              {t("whatsappMeta.signup.open")}
            </Button>
          </>
        )}
        {/* A plain link: a full load, so this page's wider policy goes with it. */}
        <a href="/accounts" className={buttonClass("ghost")}>
          {t("callback.back")}
        </a>
      </div>
    </div>
  );
}
