// `/ops/audit` (docs/plan.md §1.33): the audit log, who read or changed what, newest first, with
// filters in the URL (`?client=`, `?user=`, `?action=`, `?outcome=`, `?from=`, `?to=`) and "Load
// older" paging; and the access review (`?view=access`): every user, their role in each client and
// when they last signed in, with a CSV download. Operator only; clients don't see the log in v1.
// Drafted in the prototype's back-office style (no prototype screen; docs/ui-plan.md, like O9 Runs):
// the filters in a bar, the entries as a table in a card with "Load older" in its foot.
import {
  type AccessReviewUser,
  AUDIT_RETENTION_YEARS,
  type AuditEventRow,
  isUuid,
} from "@countersign/core";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { StatusFilter } from "../../inbox/StatusFilter";
import { useSession } from "../../session/session";
import { Field, Select, TextInput } from "../../ui/forms";
import { Page } from "../../ui/page";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  Tag,
} from "../../ui/primitives";
import { TableCard } from "./business";

type Outcome = AuditEventRow["outcome"];
type View = "log" | "access";

const VIEWS: [View, string][] = [
  ["log", "Audit log"],
  ["access", "Access review"],
];

const OUTCOMES: [Outcome, string][] = [
  ["ok", "OK"],
  ["refused", "Refused"],
  ["error", "Error"],
];

/** What the back office calls each role. */
export const ROLE_NAMES: Record<string, string> = {
  operator: "Mezonas",
  client_admin: "Admin",
  client_user: "User",
};
const roleName = (role: string | null) => (role ? (ROLE_NAMES[role] ?? role) : null);

/** "Nov 5, 2026, 9:14:03 AM": an audit row wants the second and the year. */
export function auditTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * The date filters as the API wants them: `from` is the start of that day and `to` the start of
 * the next, both in the viewer's time zone.
 */
// DECISION: the date inputs are whole days in the viewer's time zone; `to` is sent as the next
// local midnight so the chosen day is included.
export function dayBounds(from: string, to: string): { from?: string; to?: string } {
  const at = (day: string, plus: number) => {
    const [y, m, d] = day.split("-").map(Number);
    if (!y || !m || !d) return undefined;
    return new Date(y, m - 1, d + plus).toISOString();
  };
  const out: { from?: string; to?: string } = {};
  const f = from ? at(from, 0) : undefined;
  const t = to ? at(to, 1) : undefined;
  if (f) out.from = f;
  if (t) out.to = t;
  return out;
}

export function OpsAuditScreen() {
  const [params, setParams] = useSearchParams();
  const view: View = params.get("view") === "access" ? "access" : "log";
  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };

  return (
    <Page testId="ops-audit">
      <PageHeader
        title="Audit log"
        subtitle={`Who read or changed what, newest first. We keep it for ${AUDIT_RETENTION_YEARS} years.`}
        actions={
          <StatusFilter
            value={view}
            onChange={(v) => set({ view: v === "log" ? "" : v })}
            area="ops-audit-view"
            label="Show"
            options={VIEWS}
          />
        }
      />
      {view === "log" ? (
        <AuditLog params={params} set={set} />
      ) : (
        <AccessReview onActivity={(user) => set({ view: "", user })} />
      )}
    </Page>
  );
}

type Set = (patch: Record<string, string>) => void;

/** A text filter that reaches the URL once typing pauses. */
function useDraft(value: string, commit: (v: string) => void, valid: (v: string) => boolean) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `commit` reads the current params.
  useEffect(() => {
    const v = text.trim();
    if (v === value || !valid(v)) return;
    const timer = setTimeout(() => commit(v), 300);
    return () => clearTimeout(timer);
  }, [text, value]);
  return [text, setText] as const;
}

const validUser = (v: string) => v === "" || isUuid(v);

function AuditLog({ params, set }: { params: URLSearchParams; set: Set }) {
  const session = useSession();
  const api = useApiClient();
  const client = params.get("client") ?? "";
  const user = params.get("user") ?? "";
  const action = params.get("action") ?? "";
  const outcome = (OUTCOMES.find(([o]) => o === params.get("outcome"))?.[0] ?? "") as Outcome | "";
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const [userText, setUserText] = useDraft(user, (v) => set({ user: v }), validUser);
  const [actionText, setActionText] = useDraft(
    action,
    (v) => set({ action: v }),
    () => true,
  );
  const userInvalid = !validUser(userText.trim());

  const query = {
    ...(client && isUuid(client) ? { client } : {}),
    ...(user && isUuid(user) ? { user } : {}),
    ...(action ? { action } : {}),
    ...(outcome ? { outcome } : {}),
    ...dayBounds(from, to),
  };
  const key = JSON.stringify(query);
  const first = useApi(apiRoutes.opsAudit, { query });
  // Older pages, for the filters they were loaded under.
  const [older, setOlder] = useState<{
    key: string;
    events: AuditEventRow[];
    nextBefore: string | null;
  } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<unknown>(null);
  const more = older?.key === key ? older : null;
  const events = [...(first.data?.events ?? []), ...(more?.events ?? [])];
  const nextBefore = more ? more.nextBefore : (first.data?.nextBefore ?? null);

  async function loadOlder() {
    if (!nextBefore) return;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const page = await api.call(apiRoutes.opsAudit, {
        query: { ...query, before: nextBefore },
      });
      setOlder({
        key,
        events: [...(more?.events ?? []), ...page.events],
        nextBefore: page.nextBefore,
      });
    } catch (error) {
      setOlderError(error);
    } finally {
      setLoadingOlder(false);
    }
  }

  const clients = session.tenants.filter((t) => t.role === "operator");
  const filtered = Boolean(client || user || action || outcome || from || to);

  return (
    <>
      <Card pad>
        <div className="flex flex-wrap items-end gap-3" data-testid="ops-audit-filters">
          <Field label="Client" className="w-48">
            <Select
              data-testid="ops-audit-client"
              value={client}
              onChange={(e) => set({ client: e.target.value })}
              className="h-8 w-48 text-sm"
            >
              <option value="">All clients</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="User id"
            error={userInvalid ? "Not a user id." : undefined}
            className="w-72"
            testId="ops-audit-user"
          >
            <TextInput
              data-testid="ops-audit-user"
              value={userText}
              invalid={userInvalid}
              placeholder="Any user"
              onChange={(e) => setUserText(e.target.value)}
              className="h-8 w-72 text-sm reference"
            />
          </Field>
          <Field label="Action starts with" className="w-56">
            <TextInput
              data-testid="ops-audit-action"
              value={actionText}
              maxLength={200}
              placeholder="session. or GET /api/runs"
              onChange={(e) => setActionText(e.target.value)}
              className="h-8 w-56 text-sm"
            />
          </Field>
          <Field label="Outcome" className="w-36">
            <Select
              data-testid="ops-audit-outcome"
              value={outcome}
              onChange={(e) => set({ outcome: e.target.value })}
              className="h-8 w-36 text-sm"
            >
              <option value="">Any</option>
              {OUTCOMES.map(([o, label]) => (
                <option key={o} value={o}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="From" className="w-40">
            <TextInput
              type="date"
              data-testid="ops-audit-from"
              value={from}
              max={to || undefined}
              onChange={(e) => set({ from: e.target.value })}
              className="h-8 w-40 text-sm"
            />
          </Field>
          <Field label="To" className="w-40">
            <TextInput
              type="date"
              data-testid="ops-audit-to"
              value={to}
              min={from || undefined}
              onChange={(e) => set({ to: e.target.value })}
              className="h-8 w-40 text-sm"
            />
          </Field>
          {filtered ? (
            <Button
              variant="ghost"
              size="sm"
              data-testid="ops-audit-clear"
              onClick={() =>
                set({ client: "", user: "", action: "", outcome: "", from: "", to: "" })
              }
            >
              Clear filters
            </Button>
          ) : null}
        </div>
      </Card>

      {first.loading && !first.data ? <Loading /> : null}
      {first.error ? (
        <ErrorNotice
          error={first.error}
          onRetry={() => {
            setOlder(null);
            first.reload();
          }}
        />
      ) : null}
      {first.data && events.length === 0 ? (
        <EmptyState>
          {filtered
            ? "Nothing matches these filters."
            : "Nothing logged yet. Every request to the app shows here."}
        </EmptyState>
      ) : null}
      {events.length > 0 ? (
        <TableCard
          title="Entries"
          meta="Newest first"
          footer={
            <div className="flex w-full flex-col gap-3">
              <div className="flex items-center justify-between gap-3 text-sm text-ink-muted">
                <span className="figures" data-testid="ops-audit-count">
                  {events.length === 1 ? "1 entry" : `${events.length.toLocaleString()} entries`}
                  {nextBefore ? "" : ". No older entries."}
                </span>
                {nextBefore ? (
                  <Button
                    size="sm"
                    data-testid="ops-audit-older"
                    disabled={loadingOlder}
                    onClick={() => void loadOlder()}
                  >
                    {loadingOlder ? "Loading" : "Load older"}
                  </Button>
                ) : null}
              </div>
              {olderError ? (
                <ErrorNotice error={olderError} onRetry={() => void loadOlder()} />
              ) : null}
            </div>
          }
        >
          <table data-testid="ops-audit-table">
            <thead>
              <tr className="dt-cols">
                <th>When</th>
                <th>Who</th>
                <th>Client</th>
                <th>Action</th>
                <th>Outcome</th>
                <th>Target</th>
                <th>IP</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <AuditRow key={e.id} event={e} />
              ))}
            </tbody>
          </table>
        </TableCard>
      ) : null}
    </>
  );
}

function Who({ actor }: { actor: AuditEventRow["actor"] }) {
  if (actor.kind === "system") return <span className="text-ink">Mezonas</span>;
  if (actor.kind === "anonymous") return <span className="text-ink-muted">Signed out</span>;
  const role = roleName(actor.role);
  return (
    <span className="flex flex-col">
      <span className="text-ink">{actor.email ?? actor.id ?? "Unknown user"}</span>
      {role ? <span className="text-xs text-ink-muted">{role}</span> : null}
    </span>
  );
}

function OutcomeMark({ event }: { event: AuditEventRow }) {
  const status = event.httpStatus ? ` · ${event.httpStatus}` : "";
  // DECISION: an error is risk; a refusal is ink, not signal: it waits on nobody (brand book).
  if (event.outcome === "error") {
    return (
      <Badge tone="risk" testId="ops-audit-outcome-mark">
        Error{status}
      </Badge>
    );
  }
  if (event.outcome === "refused") {
    return (
      <Badge tone="neutral" testId="ops-audit-outcome-mark">
        Refused{status}
      </Badge>
    );
  }
  return (
    <span className="text-sm text-ink-muted figures" data-testid="ops-audit-outcome-mark">
      OK{status}
    </span>
  );
}

/** An id's first 8 characters; other values up to 24. */
function compact(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (typeof value === "string" && isUuid(value)) return `${value.slice(0, 8)}…`;
  return text.length > 24 ? `${text.slice(0, 23)}…` : text;
}

function Target({ target }: { target: Record<string, unknown> }) {
  const entries = Object.entries(target).filter(([, v]) => v !== null && v !== undefined);
  if (entries.length === 0) return <span className="text-ink-muted">–</span>;
  return (
    <span className="flex flex-col reference text-xs" title={JSON.stringify(target)}>
      {entries.map(([k, v]) => (
        <span key={k} className="whitespace-nowrap">
          <span className="text-ink-muted">{k}</span> <span className="text-ink">{compact(v)}</span>
        </span>
      ))}
    </span>
  );
}

function AuditRow({ event }: { event: AuditEventRow }) {
  return (
    <tr data-testid={`ops-audit-row-${event.id}`}>
      <td className="whitespace-nowrap text-ink figures" title={event.createdAt}>
        {auditTime(event.createdAt)}
      </td>
      <td data-testid="ops-audit-who">
        <Who actor={event.actor} />
      </td>
      <td data-testid="ops-audit-client-name">
        {event.client ? (
          event.client.name ? (
            <span className="text-ink">{event.client.name}</span>
          ) : (
            <span className="reference text-xs text-ink-muted" title={event.client.id}>
              {compact(event.client.id)}
            </span>
          )
        ) : (
          <span className="text-ink-muted">–</span>
        )}
      </td>
      <td className="reference text-xs text-ink" data-testid="ops-audit-action-name">
        {event.action}
      </td>
      <td>
        <OutcomeMark event={event} />
      </td>
      <td>
        <Target target={event.target} />
      </td>
      <td
        className="reference text-xs text-ink-muted whitespace-nowrap"
        title={event.userAgent ?? undefined}
      >
        {event.ip ?? "–"}
      </td>
    </tr>
  );
}

const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** One line per user and client (a user in no client gets one line with the client empty). */
export function accessReviewCsv(users: AccessReviewUser[]): string {
  const lines = [
    ["Email", "Name", "Client", "Role", "Client retired", "Last sign-in", "Last seen"],
  ];
  for (const u of users) {
    const rows = u.memberships.length > 0 ? u.memberships : [null];
    for (const m of rows) {
      lines.push([
        u.email,
        u.name ?? "",
        m?.client.name ?? "",
        m ? (roleName(m.role) ?? "") : "",
        m ? (m.client.retired ? "yes" : "no") : "",
        u.lastSignInAt ?? "",
        u.lastSeenAt ?? "",
      ]);
    }
  }
  return `${lines.map((l) => l.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function AccessReview({ onActivity }: { onActivity: (user: string) => void }) {
  const { data, error, loading, reload } = useApi(apiRoutes.opsAccessReview);

  return (
    <section data-testid="ops-access-review" className="ui-section">
      <p className="text-ink-muted">
        Everyone who can sign in to your clients, their role in each, and when we last saw them.
        Read it and remove access that should go.
      </p>
      {loading && !data ? <Loading /> : null}
      {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {data && data.users.length === 0 ? <EmptyState>No users yet.</EmptyState> : null}
      {data && data.users.length > 0 ? (
        <TableCard
          title="Access review"
          meta={
            <>
              <span data-testid="ops-access-review-generated">
                Generated {auditTime(data.generatedAt)}.
              </span>
              <Button
                size="sm"
                data-testid="ops-access-review-csv"
                onClick={() =>
                  download(
                    `access-review-${data.generatedAt.slice(0, 10)}.csv`,
                    accessReviewCsv(data.users),
                  )
                }
              >
                Download CSV
              </Button>
            </>
          }
        >
          <table data-testid="ops-access-review-table">
            <thead>
              <tr className="dt-cols">
                <th>Person</th>
                <th>Clients and roles</th>
                <th>Last sign-in</th>
                <th>Last seen</th>
                <th>
                  <span className="sr-only">Activity</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={u.id} data-testid={`ops-access-review-row-${u.id}`}>
                  <td>
                    <span className="flex flex-col py-1">
                      <span className="text-ink">{u.email}</span>
                      {u.name ? <span className="text-xs text-ink-muted">{u.name}</span> : null}
                    </span>
                  </td>
                  <td>
                    {u.memberships.length === 0 ? (
                      <span className="text-ink-muted">No clients</span>
                    ) : (
                      <span className="flex flex-wrap gap-1.5 py-1">
                        {u.memberships.map((m) => (
                          <span
                            key={m.client.id}
                            className="inline-flex items-center gap-1.5"
                            data-testid="ops-access-review-membership"
                          >
                            <Tag tone={m.role === "operator" ? "person" : "neutral"}>
                              {m.client.name} · {roleName(m.role)}
                            </Tag>
                            {m.client.retired ? <Badge>Retired</Badge> : null}
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap text-ink figures">
                    {u.lastSignInAt ? auditTime(u.lastSignInAt) : "Never"}
                  </td>
                  <td className="whitespace-nowrap text-ink figures">
                    {u.lastSeenAt ? auditTime(u.lastSeenAt) : "Never"}
                  </td>
                  <td className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid={`ops-access-review-activity-${u.id}`}
                      onClick={() => onActivity(u.id)}
                    >
                      See activity
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableCard>
      ) : null}
    </section>
  );
}
