// The portal's Requests (docs/plan.md §1.124.1): the client's problems and ideas, each a
// conversation with its Mezonas lead. A new request asks what it is ("Something isn't working" or
// "An idea or a change"), what it's about and the words. A client user sees what they raised; the
// client admin sees everyone's. Nothing internal reaches here: no notes, urgency or Reggie.
// DECISION: the portal keeps the word "Requests" (owner, 2026-11-17).
import type { PortalRequestState, PortalWorkRequest } from "@countersign/core";
import { type FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import { apiRoutes } from "../api/routes";
import { useApi, useApiClient } from "../api/useApi";
import { useI18n } from "../i18n/i18n";
import { Field, Select, TextArea, TextInput } from "../ui/forms";
import { Loaded, Page, PageGrid } from "../ui/page";
import { Button, Card, EmptyState, PageHeader } from "../ui/primitives";

const STATE_PILL: Record<PortalRequestState, string> = {
  on_it: "ds-pill--neutral",
  waiting_on_you: "ds-pill--warning",
  fixed: "ds-pill--positive",
  closed: "ds-pill--neutral",
};

export function RequestState({ state }: { state: PortalRequestState }) {
  const { t } = useI18n();
  return (
    <span className={`ds-pill ds-pill--sm ${STATE_PILL[state]}`} data-testid="request-state">
      {t(`requests.state.${state}`)}
    </span>
  );
}

export function RequestsScreen() {
  const { t } = useI18n();
  const state = useApi(apiRoutes.portalWorkRequests, { query: { status: "all" } });
  return (
    <Page testId="portal-requests">
      <PageHeader title={t("requests.title")} subtitle={t("requests.lede")} />
      <PageGrid rail={<NewRequest onRaised={state.reload} />}>
        <Loaded state={state}>
          {(data) =>
            data.items.length === 0 ? (
              <EmptyState>{t("requests.empty")}</EmptyState>
            ) : (
              <ul className="flex flex-col gap-3" data-testid="portal-requests-items">
                {data.items.map((r) => (
                  <RequestRow key={r.id} r={r} />
                ))}
              </ul>
            )
          }
        </Loaded>
      </PageGrid>
    </Page>
  );
}

function RequestRow({ r }: { r: PortalWorkRequest }) {
  const { t, fmt } = useI18n();
  return (
    <li className="ds-card p-4" data-testid={`portal-work-request-${r.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link to={`/requests/${r.id}`} className="font-medium text-ink">
          {r.title}
        </Link>
        <RequestState state={r.state} />
      </div>
      <p className="mt-1 text-sm text-ink-muted">
        {t(`requests.kind.${r.kind}`)}
        {r.service ? ` · ${r.service.name}` : ""}
        {r.raisedBy ? ` · ${r.raisedBy}` : ""} · {fmt.date(r.createdAt)}
      </p>
    </li>
  );
}

function NewRequest({ onRaised }: { onRaised: () => void }) {
  const { t } = useI18n();
  const api = useApiClient();
  const overview = useApi(apiRoutes.portalOverview);
  const services = overview.data?.services ?? [];
  const [kind, setKind] = useState<"problem" | "idea">("problem");
  const [serviceId, setServiceId] = useState("");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function send(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setFailed(false);
    try {
      await api.call(apiRoutes.portalRaiseRequest, {
        body: {
          kind,
          text: text.trim(),
          ...(subject.trim() ? { subject: subject.trim() } : {}),
          ...(serviceId ? { serviceId } : {}),
        },
      });
      setText("");
      setSubject("");
      setServiceId("");
      onRaised();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title={t("requests.new")} pad testId="portal-new-request">
      <form className="flex flex-col gap-4" onSubmit={(e) => void send(e)}>
        <Field label={t("requests.kindQuestion")}>
          <Select
            value={kind}
            onChange={(e) => setKind(e.target.value as "problem" | "idea")}
            data-testid="new-request-kind"
          >
            <option value="problem">{t("requests.kind.problem")}</option>
            <option value="idea">{t("requests.kind.idea")}</option>
          </Select>
        </Field>
        <Field label={t("requests.service")}>
          <Select value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
            <option value="">{t("requests.serviceNone")}</option>
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("requests.subject")}>
          <TextInput value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} />
        </Field>
        <Field label={t("requests.text")}>
          <TextArea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={5}
            data-testid="new-request-text"
          />
        </Field>
        {failed ? <p className="text-sm text-risk">{t("requests.failed")}</p> : null}
        <Button
          type="submit"
          variant="primary"
          disabled={busy || !text.trim()}
          data-testid="new-request-send"
        >
          {t("requests.send")}
        </Button>
      </form>
    </Card>
  );
}
