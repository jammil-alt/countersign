// A request in the portal (docs/plan.md §1.123.1): the conversation with the client's Mezonas
// lead, and, once we ask, "Confirm it's fixed" or "It's still happening". The lead is the only
// person at Mezonas named; internal notes never reach here.
import type { PortalWorkRequestDetail } from "@countersign/core";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiRoutes } from "../api/routes";
import { useApi, useApiClient } from "../api/useApi";
import { useI18n } from "../i18n/i18n";
import { TextArea } from "../ui/forms";
import { Loaded, Page } from "../ui/page";
import { Button, PageHeader } from "../ui/primitives";
import { RequestState } from "./RequestsScreen";

export function RequestDetailScreen() {
  const { id = "" } = useParams();
  const state = useApi(apiRoutes.portalWorkRequest, { params: { id } });
  return (
    <Page width="narrow" testId="portal-request-detail">
      <Loaded state={state}>{(d) => <Detail d={d} reload={state.reload} />}</Loaded>
    </Page>
  );
}

function Detail({ d, reload }: { d: PortalWorkRequestDetail; reload: () => void }) {
  const { t, fmt } = useI18n();
  const api = useApiClient();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const r = d.request;
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
      reload();
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Link to="/requests" className="text-sm">
        {t("requests.back")}
      </Link>
      <PageHeader
        eyebrow={
          r.number ? t("requests.number", { n: String(r.number) }) : t(`requests.kind.${r.kind}`)
        }
        title={r.title}
        badge={<RequestState state={r.state} />}
      />
      {r.canConfirm ? (
        <div className="mb-4 flex flex-wrap gap-2" data-testid="request-verify">
          <Button
            variant="primary"
            disabled={busy}
            onClick={() =>
              void act(() => api.call(apiRoutes.portalConfirmFix, { params: { id: r.id } }))
            }
          >
            {t("requests.confirm")}
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              void act(() => api.call(apiRoutes.portalReopenRequest, { params: { id: r.id } }))
            }
          >
            {t("requests.stillHappening")}
          </Button>
        </div>
      ) : null}
      <ol className="flex flex-col gap-3" data-testid="request-messages">
        {d.messages.map((m) => (
          <li key={m.id} className="ds-card p-3">
            <div className="flex flex-wrap gap-2 text-sm">
              <b>{m.from === "you" ? t("requests.you") : m.name}</b>
              <span className="text-ink-muted">{fmt.time(m.at)}</span>
            </div>
            <p className="mt-1 whitespace-pre-wrap">{m.text}</p>
          </li>
        ))}
      </ol>
      <form
        className="mt-4 flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          void act(async () => {
            await api.call(apiRoutes.portalWorkRequestMessage, {
              params: { id: r.id },
              body: { text: text.trim() },
            });
            setText("");
          });
        }}
      >
        <TextArea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          aria-label={t("requests.reply")}
          placeholder={t("requests.reply")}
          data-testid="request-reply"
        />
        <div>
          <Button type="submit" variant="primary" disabled={busy || !text.trim()}>
            {t("requests.replySend")}
          </Button>
        </div>
      </form>
    </>
  );
}
