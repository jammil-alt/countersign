// `/requests` (ARCHITECTURE §15): ask us for a change to one of your services, or for something
// new, and follow what happened to each ask. Client users see the requests they raised; the client
// admin sees everyone's. Open requests wait on us, not on the client, so they show in a plain
// pill; done is positive, with what changed and our note.
import {
  type PortalRequest,
  REQUEST_SUBJECT_MAX,
  REQUEST_TEXT_MAX,
  type RequestStatus,
} from "@countersign/core";
import { type FormEvent, useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import type { PlainKey } from "../../i18n/catalog";
import { EN, type I18n, useI18n } from "../../i18n/i18n";
import { StatusFilter } from "../../inbox/StatusFilter";
import { useSession } from "../../session/session";
import { Field, Select, TextArea, TextInput } from "../../ui/forms";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  SectionLabel,
  type Tone,
} from "../../ui/primitives";

type Filter = "all" | "open" | "resolved";

export const REQUEST_STATUS: Record<RequestStatus, { label: PlainKey; tone: Tone }> = {
  open: { label: "requests.status.open", tone: "neutral" },
  done: { label: "requests.status.done", tone: "positive" },
  declined: { label: "requests.status.declined", tone: "neutral" },
};

/** "Nov 3, 2026", in the reader's format. */
export function when(iso: string, { fmt }: Pick<I18n, "fmt"> = EN): string {
  return fmt.date(iso);
}

export function PortalRequestsScreen() {
  const { t } = useI18n();
  const session = useSession();
  const client = session.tenants.find((t) => t.id === session.activeTenantId) ?? session.tenants[0];
  const isAdmin = client?.role === "client_admin";
  const [filter, setFilter] = useState<Filter>("all");
  const { data, error, loading, reload } = useApi(apiRoutes.portalRequests, {
    query: { status: filter },
  });

  return (
    <div className="max-w-5xl">
      <PageHeader title={t("requests.title")} subtitle={t("requests.subtitle")} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <section className="order-2 xl:order-1">
          <SectionLabel
            action={
              <StatusFilter
                value={filter}
                onChange={setFilter}
                area="portal-requests"
                label={t("requests.which")}
                options={[
                  ["all", t("requests.filter.all")],
                  ["open", t("requests.filter.open")],
                  ["resolved", t("requests.filter.resolved")],
                ]}
              />
            }
          >
            {isAdmin ? t("requests.team") : t("requests.yours")}
          </SectionLabel>
          {loading && !data ? <Loading /> : null}
          {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
          {data && data.items.length === 0 ? (
            <EmptyState>
              {filter === "all" ? t("requests.emptyAll") : t("requests.emptyFiltered")}
            </EmptyState>
          ) : null}
          <div data-testid="portal-requests-list" className="flex flex-col gap-4">
            {data?.items.map((item) => (
              <RequestCard key={item.id} item={item} showWho={isAdmin} />
            ))}
          </div>
        </section>
        <div className="order-1 xl:order-2">
          <RaiseRequest onRaised={reload} />
        </div>
      </div>
    </div>
  );
}

function RaiseRequest({ onRaised }: { onRaised: () => void }) {
  const api = useApiClient();
  const { t } = useI18n();
  const overview = useApi(apiRoutes.portalOverview);
  const services = overview.data?.services ?? [];
  const [serviceId, setServiceId] = useState("");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    setSent(false);
    try {
      await api.call(apiRoutes.portalRaiseRequest, {
        body: {
          text: text.trim(),
          ...(subject.trim() ? { subject: subject.trim() } : {}),
          ...(serviceId ? { serviceId } : {}),
        },
      });
      setText("");
      setSubject("");
      setServiceId("");
      setSent(true);
      onRaised();
    } catch {
      setError(t("requests.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5" testId="portal-request-form">
      <SectionLabel>{t("requests.askUs")}</SectionLabel>
      <form className="flex flex-col gap-4" onSubmit={(e) => void send(e)}>
        <Field label={t("requests.about")}>
          <Select
            data-testid="portal-request-service"
            value={serviceId}
            onChange={(e) => setServiceId(e.target.value)}
          >
            <option value="">{t("requests.somethingNew")}</option>
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("requests.subject")} hint={t("requests.subjectHint")}>
          <TextInput
            data-testid="portal-request-subject"
            value={subject}
            maxLength={REQUEST_SUBJECT_MAX}
            onChange={(e) => setSubject(e.target.value)}
          />
        </Field>
        <Field label={t("requests.what")}>
          <TextArea
            data-testid="portal-request-text"
            rows={5}
            value={text}
            maxLength={REQUEST_TEXT_MAX}
            placeholder={t("requests.placeholder")}
            onChange={(e) => {
              setText(e.target.value);
              setSent(false);
            }}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            variant="primary"
            data-testid="portal-request-send"
            disabled={busy || !text.trim()}
          >
            {busy ? t("common.sending") : t("requests.send")}
          </Button>
          {sent ? (
            <span className="text-sm text-ink-muted" data-testid="portal-request-sent">
              {t("requests.sent")}
            </span>
          ) : null}
          {error ? <span className="ds-error text-sm">{error}</span> : null}
        </div>
      </form>
    </Card>
  );
}

function RequestCard({ item, showWho }: { item: PortalRequest; showWho: boolean }) {
  const i18n = useI18n();
  const { t } = i18n;
  const status = REQUEST_STATUS[item.status];
  return (
    <Card testId={`portal-request-${item.id}`} className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-ink" data-testid="portal-request-subject-text">
            {item.subject}
          </p>
          <p className="text-sm text-ink-muted">
            {item.service ? `${item.service.name} · ` : ""}
            {showWho && item.raisedBy?.name ? `${item.raisedBy.name} · ` : ""}
            {when(item.createdAt, i18n)}
          </p>
        </div>
        <Badge tone={status.tone} testId="portal-request-status">
          {t(status.label)}
        </Badge>
      </div>
      <p className="mt-3 whitespace-pre-wrap text-ink">{item.text}</p>
      {item.status !== "open" ? (
        <div className="mt-4 border-t border-line pt-4" data-testid="portal-request-reply">
          <p className="text-sm text-ink-muted">
            {item.resolvedAt
              ? t(item.status === "done" ? "requests.doneOn" : "requests.declinedOn", {
                  date: when(item.resolvedAt, i18n),
                })
              : t(item.status === "done" ? "requests.status.done" : "requests.status.declined")}
          </p>
          {item.note ? <p className="mt-1 whitespace-pre-wrap text-ink">{item.note}</p> : null}
          {item.changes.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1 text-sm" data-testid="portal-request-changes">
              {item.changes.map((c) => (
                <li key={`${c.service.id}:${c.version}`} className="text-ink">
                  {t("requests.nowOnVersion", {
                    service: c.service.name,
                    version: String(c.version),
                  })}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
