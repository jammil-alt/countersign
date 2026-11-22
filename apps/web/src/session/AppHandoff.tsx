// `/sign-in/app` (docs/plan.md §1.219; open.md M8, D7): after the browser signs in for one of our
// apps (the phone or the desktop app), the session waits here until the person says to open the
// app. Another app on the phone or computer may have registered `mezonas://` and started the
// sign-in itself; with the browser already signed in it would otherwise finish with nobody looking.
// The page names the app and the person; Open hands the session over (the API answers with the
// app's link), Cancel ends the app's sign-in and keeps this browser's session. Every check is the
// API's; this page only asks.
import type { MobileApp } from "@countersign/core";
import { type ReactNode, useState } from "react";
import { apiRoutes } from "../api/routes";
import { useApi, useApiClient } from "../api/useApi";
import { useI18n } from "../i18n/i18n";
import { Button, ErrorNotice, Loading } from "../ui/primitives";
import { appHandoffWords, EXPLAIN, TITLE } from "./app-handoff-words";
import { SignInFrame } from "./SignIn";

/** Where the browser goes next; a seam for tests (jsdom can't follow `mezonas://`). */
export const go = { to: (url: string) => window.location.assign(url) };

export function AppHandoffScreen() {
  const w = appHandoffWords(useI18n().locale);
  const pending = useApi(apiRoutes.mobileHandoffPending, { cache: "none" });
  const api = useApiClient();
  const [busy, setBusy] = useState<"open" | "cancel" | null>(null);
  const [error, setError] = useState<unknown>(null);

  async function answer(open: boolean) {
    setBusy(open ? "open" : "cancel");
    setError(null);
    try {
      const r = await api.call(apiRoutes.mobileHandoffConfirm, { body: { open } });
      go.to(r.redirectTo);
    } catch (e) {
      setError(e);
      setBusy(null);
    }
  }

  let body: ReactNode;
  if (pending.data) {
    const app: MobileApp = pending.data.app;
    body = (
      <div className="flex flex-col gap-4" data-testid="app-handoff" data-app={app}>
        <h1 className="type-heading text-ink">{w(TITLE[app])}</h1>
        <p className="text-ink" data-testid="app-handoff-who">
          {w("who", { email: pending.data.email })}
        </p>
        <p className="text-ink-muted">{w(EXPLAIN[app])}</p>
        <p className="text-ink-muted" data-testid="app-handoff-warn">
          {w("warn")}
        </p>
        {error ? <ErrorNotice error={error} /> : null}
        <div className="flex flex-wrap gap-3">
          <Button
            variant="primary"
            working={busy === "open"}
            disabled={busy !== null}
            onClick={() => void answer(true)}
            data-testid="app-handoff-open"
          >
            {w("open")}
          </Button>
          <Button
            working={busy === "cancel"}
            disabled={busy !== null}
            onClick={() => void answer(false)}
            data-testid="app-handoff-cancel"
          >
            {w("cancel")}
          </Button>
        </div>
      </div>
    );
  } else if (pending.error) {
    // Any refusal means the same to the person: this sign-in can't go on; start again.
    body = (
      <div className="flex flex-col gap-3" data-testid="app-handoff-gone">
        <h1 className="type-heading text-ink">{w("goneTitle")}</h1>
        <p className="text-ink">{w("gone")}</p>
      </div>
    );
  } else {
    body = <Loading />;
  }

  return (
    <SignInFrame>
      <p className="eyebrow text-ink-muted">{w("eyebrow")}</p>
      {body}
    </SignInFrame>
  );
}
