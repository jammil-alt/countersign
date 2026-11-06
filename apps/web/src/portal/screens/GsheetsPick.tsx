// v0.14 W4-D: `/connections/gsheets/pick`, where the client admin picks the spreadsheets agents may
// use (ARCHITECTURE §6.11 row 7, docs/plan.md §1.52). Google's Picker grants our Google project
// `drive.file` access to each sheet picked; the page then sends the ids to the API, which checks
// them with the connection's own grant and keeps them. This page is always loaded as a document
// (never by client-side navigation): only this path's Content-Security-Policy lets Google's script
// and frame in (apps/web/public/_headers), and it goes back to Connections with a full load too.
import { useEffect, useRef, useState } from "react";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { useI18n } from "../../i18n/i18n";
import { Button, buttonClass, ErrorNotice, Loading, PageHeader } from "../../ui/primitives";

type Picker = ResponseOf<typeof apiRoutes.portalGsheetsPicker>;

/** Google's two scripts: the Picker's loader and Google Identity Services. Nothing else is loaded. */
export const GOOGLE_API_SCRIPT = "https://apis.google.com/js/api.js";
export const GOOGLE_GSI_SCRIPT = "https://accounts.google.com/gsi/client";
const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const SPREADSHEET_MIME = "application/vnd.google-apps.spreadsheet";

// The parts of Google's globals this page uses.
interface TokenResponse {
  access_token?: string;
  error?: string;
}
interface GoogleGlobals {
  accounts: {
    oauth2: {
      initTokenClient(config: {
        client_id: string;
        scope: string;
        hint?: string;
        prompt?: string;
        callback: (r: TokenResponse) => void;
        error_callback?: (e: unknown) => void;
      }): { requestAccessToken(): void };
    };
  };
  picker: {
    Action: { PICKED: string; CANCEL: string };
    Feature: { MULTISELECT_ENABLED: string };
    ViewId: { SPREADSHEETS: string };
    DocsView: new (
      viewId: string,
    ) => { setMimeTypes(m: string): unknown; setIncludeFolders(b: boolean): unknown };
    PickerBuilder: new () => PickerBuilder;
  };
}
interface PickerBuilder {
  addView(v: unknown): PickerBuilder;
  enableFeature(f: string): PickerBuilder;
  setOAuthToken(t: string): PickerBuilder;
  setDeveloperKey(k: string): PickerBuilder;
  setAppId(id: string): PickerBuilder;
  setOrigin(o: string): PickerBuilder;
  setCallback(cb: (data: { action: string; docs?: { id: string }[] }) => void): PickerBuilder;
  build(): { setVisible(v: boolean): void };
}
interface GapiGlobal {
  load(lib: string, cb: { callback: () => void; onerror: () => void }): void;
}
type GoogleWindow = Window & { google?: GoogleGlobals; gapi?: GapiGlobal };

/** Adds one of Google's scripts once; resolves when it has loaded. */
function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = Array.from(document.scripts).find((s) => s.src === src);
    if (existing?.dataset.loaded === "1") return resolve();
    const el = existing ?? document.createElement("script");
    el.addEventListener("load", () => {
      el.dataset.loaded = "1";
      resolve();
    });
    el.addEventListener("error", () => reject(new Error(`${src} didn't load`)));
    if (!existing) {
      el.src = src;
      el.async = true;
      document.head.appendChild(el);
    }
  });
}

async function loadGoogle(): Promise<GoogleWindow> {
  await Promise.all([loadScript(GOOGLE_API_SCRIPT), loadScript(GOOGLE_GSI_SCRIPT)]);
  const w = window as GoogleWindow;
  const gapi = w.gapi;
  if (!gapi) throw new Error("Google's loader is missing");
  await new Promise<void>((resolve, reject) =>
    gapi.load("picker", { callback: resolve, onerror: () => reject(new Error("picker")) }),
  );
  if (!w.google?.picker || !w.google.accounts) throw new Error("Google's picker is missing");
  return w;
}

/** Back to Connections with a full load, so this page's wider policy goes with it. */
function backToConnections() {
  window.location.assign("/accounts");
}

type Phase = "loading" | "ready" | "picking" | "saving" | "cancelled" | "failed";

export function GsheetsPickScreen() {
  const api = useApiClient();
  const { t } = useI18n();
  const { data, error, loading, reload } = useApi(apiRoutes.portalGsheetsPicker);
  const [phase, setPhase] = useState<Phase>("loading");
  const [saveError, setSaveError] = useState<unknown>(null);
  const google = useRef<GoogleWindow | null>(null);

  useEffect(() => {
    if (!data?.available) return;
    let live = true;
    loadGoogle().then(
      (w) => {
        if (!live) return;
        google.current = w;
        setPhase("ready");
      },
      () => live && setPhase("failed"),
    );
    return () => {
      live = false;
    };
  }, [data?.available]);

  async function save(config: Picker, picked: string[]) {
    setPhase("saving");
    setSaveError(null);
    const kept = config.sheets.filter((s) => s.usable).map((s) => s.id);
    try {
      await api.call(apiRoutes.portalGsheetsSheets, {
        body: { sheetIds: [...new Set([...kept, ...picked])].slice(0, 50) },
      });
      backToConnections();
    } catch (e) {
      setSaveError(e);
      setPhase("ready");
    }
  }

  // Runs in the click itself: Google's sign-in window is a pop-up, which browsers allow only then.
  function open(config: Picker) {
    const w = google.current;
    if (!w?.google || !config.clientId || !config.developerKey || !config.appId) return;
    const g = w.google;
    const { developerKey, appId } = config;
    setPhase("picking");
    // DECISION: the Picker's token comes from Google Identity Services in this browser, for this
    // person, and stays in this page's memory: the connection's own tokens never leave the Worker
    // (invariant 13). It is never revoked here: revoking ends the whole grant for our client,
    // the connection's refresh token included. It expires within the hour.
    const client = g.accounts.oauth2.initTokenClient({
      client_id: config.clientId,
      scope: DRIVE_FILE_SCOPE,
      ...(config.account ? { hint: config.account } : {}),
      prompt: "",
      callback: (r) => {
        if (!r.access_token) {
          setPhase("failed");
          return;
        }
        const view = new g.picker.DocsView(g.picker.ViewId.SPREADSHEETS);
        view.setMimeTypes(SPREADSHEET_MIME);
        view.setIncludeFolders(false);
        new g.picker.PickerBuilder()
          .addView(view)
          .enableFeature(g.picker.Feature.MULTISELECT_ENABLED)
          .setOAuthToken(r.access_token)
          .setDeveloperKey(developerKey)
          .setAppId(appId)
          .setOrigin(window.location.origin)
          .setCallback((d) => {
            if (d.action === g.picker.Action.PICKED) {
              void save(
                config,
                (d.docs ?? []).map((doc) => doc.id),
              );
            } else if (d.action === g.picker.Action.CANCEL) {
              setPhase("cancelled");
            }
          })
          .build()
          .setVisible(true);
      },
      error_callback: () => setPhase("failed"),
    });
    client.requestAccessToken();
  }

  return (
    <div>
      <PageHeader title={t("gsheets.pick.title")} subtitle={t("gsheets.pick.subtitle")} />
      {loading && !data ? <Loading /> : null}
      {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {saveError ? (
        <div className="mb-3">
          <ErrorNotice error={saveError} />
        </div>
      ) : null}
      {data ? (
        <div className="flex flex-col items-start gap-3" data-testid="gsheets-pick">
          {!data.available ? (
            <p className="text-sm text-ink-muted">{t("gsheets.notSetUp")}</p>
          ) : phase === "loading" ? (
            <Loading label={t("gsheets.pick.loading")} />
          ) : phase === "saving" ? (
            <Loading label={t("gsheets.pick.saving")} />
          ) : (
            <>
              {phase === "cancelled" ? (
                <p className="text-sm text-ink-muted">{t("gsheets.pick.cancelled")}</p>
              ) : null}
              {phase === "failed" ? (
                <p role="alert" className="text-sm text-risk-ink">
                  {t("gsheets.pick.failed")}
                </p>
              ) : null}
              <Button
                variant="primary"
                data-testid="gsheets-pick-open"
                disabled={phase === "picking" || !google.current}
                onClick={() => open(data)}
              >
                {t("gsheets.pick.open")}
              </Button>
            </>
          )}
          {/* A plain link: a full load, so this page's wider policy goes with it. */}
          <a href="/accounts" className={buttonClass("ghost")}>
            {t("callback.back")}
          </a>
        </div>
      ) : null}
    </div>
  );
}
