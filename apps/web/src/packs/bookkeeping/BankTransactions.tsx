// B-6 (docs/plan.md §1.79): the Bank transactions screen. The portal shows the client's own: each
// transaction, its status and where it was booked. The back office shows the same for a client it
// serves (`clientId`), with what only the operator sets: which ledger account each account on the
// feed is and whether it books, the client's rules, and the chart of accounts with what each
// account is for. Payees and account names are data and show as written; nothing here names an
// agent, a prompt or a cost. The back office's own words are English, as its other screens.
import { type CSSProperties, useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { useI18n } from "../../i18n/i18n";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  SectionLabel,
} from "../../ui/primitives";
import { dayLabel } from "../../usage/format";
import {
  type ChartAccount,
  type FeedAccount,
  type RuleRow,
  STATUS_LABEL,
  STATUS_TONE,
  type TransactionsReport,
} from "./types";

const PACK = "bookkeeping";

export function BankTransactionsView({ clientId }: { clientId?: string }) {
  const { t, fmt, intl } = useI18n();
  const portal = useApi(
    apiRoutes.portalPackReport,
    clientId ? null : { params: { pack: PACK, report: "transactions" } },
  );
  const ops = useApi(
    apiRoutes.opsClientPackReport,
    clientId ? { params: { id: clientId, pack: PACK, report: "transactions" } } : null,
  );
  const { data, error, loading, reload } = clientId ? ops : portal;
  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  const report = (data?.report ?? {
    counts: {},
    accounts: [],
    transactions: [],
  }) as unknown as TransactionsReport;
  const booked = (report.counts.posted ?? 0) + (report.counts.matched ?? 0);
  const waiting = report.counts.needs_review ?? 0;
  return (
    <div className="flex flex-col gap-6" data-testid="bookkeeping-transactions">
      <PageHeader
        title={t("bookkeeping.transactions.title")}
        subtitle={t("bookkeeping.transactions.description")}
      />
      <div className="flex flex-wrap gap-2" data-testid="bookkeeping-counts">
        <Badge tone="positive">{t("bookkeeping.transactions.booked", { count: booked })}</Badge>
        {waiting > 0 ? (
          <Badge tone="warning">{t("bookkeeping.transactions.waiting", { count: waiting })}</Badge>
        ) : null}
      </div>
      {clientId ? (
        <FeedAccounts clientId={clientId} accounts={report.accounts} onChange={reload} />
      ) : null}
      {report.transactions.length === 0 ? (
        <EmptyState>{t("bookkeeping.transactions.empty")}</EmptyState>
      ) : (
        <div className="dt dt-ana" style={{ "--dt-max-h": "640px" } as CSSProperties}>
          <div className="dt-scroll">
            <table data-testid="bookkeeping-transactions-table">
              <thead>
                <tr className="dt-cols">
                  <th>{t("bookkeeping.transactions.date")}</th>
                  <th>{t("bookkeeping.transactions.payee")}</th>
                  <th>{t("bookkeeping.transactions.account")}</th>
                  <th className="n">{t("bookkeeping.transactions.amount")}</th>
                  <th>{t("bookkeeping.transactions.status")}</th>
                  <th>{t("bookkeeping.transactions.bookedTo")}</th>
                </tr>
              </thead>
              <tbody>
                {report.transactions.map((r) => (
                  <tr key={r.id} data-testid="bookkeeping-transaction-row">
                    <td>{dayLabel(r.date, intl)}</td>
                    <td className="dt-who">
                      <b>{r.payee ?? "—"}</b>
                    </td>
                    <td>{[r.account, r.mask ? `…${r.mask}` : null].filter(Boolean).join(" ")}</td>
                    <td className="n ds-num">
                      {r.direction === "in" ? "+" : "−"}
                      {fmt.money(r.amount, r.currency)}
                    </td>
                    <td>
                      <Badge tone={STATUS_TONE[r.status]} testId="bookkeeping-transaction-status">
                        {t(STATUS_LABEL[r.status])}
                      </Badge>
                    </td>
                    <td>{r.bookedTo ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {clientId ? <Rules clientId={clientId} /> : null}
      {clientId ? <Chart clientId={clientId} /> : null}
    </div>
  );
}

// ── The back office's part ──────────────────────────────────────────────────────────────────────

function useChart(clientId: string) {
  return useApi(apiRoutes.opsClientPackReport, {
    params: { id: clientId, pack: PACK, report: "accounts" },
  });
}

function useAction(clientId: string) {
  const client = useApiClient();
  return (action: string, body: Record<string, unknown>) =>
    client.call(apiRoutes.opsClientPackAction, {
      params: { id: clientId, pack: PACK, action },
      body,
    });
}

/** Ledger kinds an account on the bank feed may link to (as the pack's link action allows). */
const LINKABLE_KINDS = ["bank", "card", "other_current_asset", "other_current_liability"];

const MODE_WORDS = { off: "Off", suggest: "Suggest only", book: "Book in QuickBooks" } as const;

/** Each bank or card account on the feed: its ledger account, and whether it books. */
function FeedAccounts({
  clientId,
  accounts,
  onChange,
}: {
  clientId: string;
  accounts: FeedAccount[];
  onChange: () => void;
}) {
  const chart = useChart(clientId);
  const act = useAction(clientId);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const [draft, setDraft] = useState<Record<string, Partial<FeedAccount>>>({});
  const money = (
    (chart.data?.report as { accounts?: ChartAccount[] } | undefined)?.accounts ?? []
  ).filter((a) => a.active && LINKABLE_KINDS.includes(a.kind));
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(null);
    try {
      await fn();
      onChange();
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card pad testId="bookkeeping-feed-accounts">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionLabel>Accounts on the bank feed</SectionLabel>
        <Button
          size="sm"
          disabled={busy}
          data-testid="bookkeeping-import"
          onClick={() => void run(() => act("import", {}))}
        >
          Read the feed now
        </Button>
      </div>
      <p className="mb-3 text-sm text-ink-muted">
        An account books only once it is linked to its QuickBooks account and switched on. If the
        client keeps QuickBooks' own bank feed for an account, set it to suggest only.
      </p>
      {accounts.length === 0 ? (
        <EmptyState>No accounts yet: connect the client's bank, then read the feed.</EmptyState>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {accounts.map((a) => {
            const d = { ...a, ...draft[a.id] };
            return (
              <li
                key={a.id}
                className="flex flex-wrap items-center gap-2 py-3"
                data-testid="bookkeeping-feed-account"
              >
                <span className="min-w-40 font-medium text-ink">
                  {[a.name, a.mask ? `…${a.mask}` : null].filter(Boolean).join(" ")}
                </span>
                <select
                  className="ds-select min-w-48"
                  aria-label={`QuickBooks account for ${a.name ?? "this account"}`}
                  value={d.ledgerAccountId ?? ""}
                  onChange={(e) =>
                    setDraft((c) => ({
                      ...c,
                      [a.id]: { ...c[a.id], ledgerAccountId: e.target.value || null },
                    }))
                  }
                >
                  <option value="">Not linked</option>
                  {money.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.fullName}
                    </option>
                  ))}
                </select>
                <select
                  className="ds-select"
                  aria-label={`What we do with ${a.name ?? "this account"}`}
                  value={d.mode}
                  onChange={(e) =>
                    setDraft((c) => ({
                      ...c,
                      [a.id]: { ...c[a.id], mode: e.target.value as FeedAccount["mode"] },
                    }))
                  }
                >
                  {(["off", "suggest", "book"] as const).map((m) => (
                    <option key={m} value={m}>
                      {MODE_WORDS[m]}
                    </option>
                  ))}
                </select>
                <input
                  type="date"
                  className="ds-input"
                  aria-label="Book from"
                  value={d.bookFrom ?? ""}
                  onChange={(e) =>
                    setDraft((c) => ({
                      ...c,
                      [a.id]: { ...c[a.id], bookFrom: e.target.value || null },
                    }))
                  }
                />
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy || !draft[a.id]}
                  data-testid="bookkeeping-link-save"
                  onClick={() =>
                    void run(async () => {
                      await act("link-account", {
                        linkId: a.id,
                        ledgerAccountId: d.ledgerAccountId ?? null,
                        mode: d.mode,
                        bookFrom: d.bookFrom ?? null,
                      });
                      setDraft((c) => {
                        const { [a.id]: _done, ...rest } = c;
                        return rest;
                      });
                    })
                  }
                >
                  Save
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {problem ? <ErrorNotice error={problem} /> : null}
    </Card>
  );
}

/** The client's rules: a person's and the learned ones; add one, or turn one off. */
function Rules({ clientId }: { clientId: string }) {
  const rules = useApi(apiRoutes.opsClientPackReport, {
    params: { id: clientId, pack: PACK, report: "rules" },
  });
  const chart = useChart(clientId);
  const act = useAction(clientId);
  const [payee, setPayee] = useState("");
  const [account, setAccount] = useState("");
  const [direction, setDirection] = useState<"out" | "in">("out");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const list = ((rules.data?.report as { rules?: RuleRow[] } | undefined)?.rules ??
    []) as RuleRow[];
  const accounts = (
    (chart.data?.report as { accounts?: ChartAccount[] } | undefined)?.accounts ?? []
  ).filter((a) => a.active);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(null);
    try {
      await fn();
      rules.reload();
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card pad testId="bookkeeping-rules">
      <SectionLabel>Rules</SectionLabel>
      <p className="mb-3 text-sm text-ink-muted">
        A rule books a payee to one account without asking. Two approvals of the same payee to the
        same account make a learned rule; a person's correction turns it off.
      </p>
      {list.length === 0 ? (
        <EmptyState>No rules yet.</EmptyState>
      ) : (
        <ul className="mb-4 flex flex-col divide-y divide-line">
          {list.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm"
              data-testid="bookkeeping-rule"
            >
              <span className="text-ink">
                <b>{r.payee}</b> {r.direction === "out" ? "→" : "←"} {r.account}
              </span>
              <span className="flex items-center gap-2">
                <Badge tone={r.source === "person" ? "person" : "neutral"}>
                  {r.source === "person" ? "A person's" : "Learned"}
                </Badge>
                <span className="text-ink-muted">{`Used ${r.hits} times`}</span>
                {r.active ? (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => void run(() => act("turn-off-rule", { ruleId: r.id }))}
                  >
                    Turn off
                  </Button>
                ) : (
                  <Badge>Off</Badge>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="ds-input min-w-48"
          aria-label="Payee"
          placeholder="Payee, as the bank writes it"
          value={payee}
          onChange={(e) => setPayee(e.target.value)}
        />
        <select
          className="ds-select"
          aria-label="Money"
          value={direction}
          onChange={(e) => setDirection(e.target.value as "out" | "in")}
        >
          <option value="out">Money out</option>
          <option value="in">Money in</option>
        </select>
        <select
          className="ds-select min-w-48"
          aria-label="Account"
          value={account}
          onChange={(e) => setAccount(e.target.value)}
        >
          <option value="">Account</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.fullName}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant="primary"
          disabled={busy || !payee.trim() || !account}
          data-testid="bookkeeping-rule-add"
          onClick={() =>
            void run(async () => {
              await act("add-rule", { payee: payee.trim(), direction, ledgerAccountId: account });
              setPayee("");
            })
          }
        >
          Add rule
        </Button>
      </div>
      {problem ? <ErrorNotice error={problem} /> : null}
    </Card>
  );
}

const NOTE_SOURCE = { client: "The client", operator: "Us", agent: "Learned" } as const;

/** The chart of accounts with what each is for: notes in three voices and the payees booked. */
function Chart({ clientId }: { clientId: string }) {
  const chart = useChart(clientId);
  const act = useAction(clientId);
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<unknown>(null);
  if (chart.error) return <ErrorNotice error={chart.error} onRetry={chart.reload} />;
  const accounts = (
    (chart.data?.report as { accounts?: ChartAccount[] } | undefined)?.accounts ?? []
  ).filter((a) => a.active);
  return (
    <Card pad testId="bookkeeping-chart">
      <SectionLabel>Chart of accounts</SectionLabel>
      <p className="mb-3 text-sm text-ink-muted">
        From QuickBooks. What each account is for: the client's words first, then ours, then what
        was learned from what was booked there.
      </p>
      {accounts.length === 0 ? (
        <EmptyState>No accounts yet: connect QuickBooks.</EmptyState>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {accounts.map((a) => (
            <li
              key={a.id}
              className="flex flex-col gap-1 py-3"
              data-testid="bookkeeping-chart-account"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-ink">
                  <b>{[a.number, a.fullName].filter(Boolean).join(" ")}</b>{" "}
                  <span className="text-ink-muted">{a.type}</span>
                </span>
                <Button size="sm" onClick={() => setOpen(open === a.id ? null : a.id)}>
                  Add a note
                </Button>
              </div>
              {a.description ? <p className="text-sm text-ink-muted">{a.description}</p> : null}
              {a.notes.map((n) => (
                <p key={n.id} className="text-sm text-ink">
                  <Badge tone={n.source === "agent" ? "neutral" : "person"}>
                    {NOTE_SOURCE[n.source]}
                  </Badge>{" "}
                  {n.note}
                </p>
              ))}
              {a.examples.length > 0 ? (
                <p className="text-sm text-ink-muted">
                  {`Booked here: ${a.examples.map((e) => `${e.payee} (${e.times})`).join(", ")}`}
                </p>
              ) : null}
              {open === a.id ? (
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    className="ds-input min-w-64 flex-1"
                    aria-label={`What ${a.fullName} is for`}
                    maxLength={500}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={!note.trim()}
                    onClick={async () => {
                      setProblem(null);
                      try {
                        await act("add-account-note", { ledgerAccountId: a.id, note: note.trim() });
                        setNote("");
                        setOpen(null);
                        chart.reload();
                      } catch (e) {
                        setProblem(e);
                      }
                    }}
                  >
                    Save
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {problem ? <ErrorNotice error={problem} /> : null}
    </Card>
  );
}
