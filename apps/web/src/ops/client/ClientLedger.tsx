// The back office's chart of accounts (docs/plan.md §1.79; owner 2026-11-08: full control of the
// ledger's set-up, always behind an approval gate). A client's ledger per accounting connection:
// accounts with what each is for, classes and locations. Adding or changing one shows the change
// first; "Sign and save" is the person's signature, recorded as an external action they approved
// and written once to the client's accounting tool. Nothing is deleted: a record is made inactive.
// Back-office words are English, as its other screens.
import { useState } from "react";
import { useParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { shortTime } from "../../runs/format";
import { Loaded } from "../../ui/page";
import { Badge, Button, Card, EmptyState, SectionLabel } from "../../ui/primitives";
import { SkeletonCard } from "../../ui/skeleton";
import { ClientFrame } from "./ClientFrame";

/** QuickBooks' account types (connector `QBO_ACCOUNT_TYPES`). */
const ACCOUNT_TYPES = [
  "Bank",
  "Other Current Asset",
  "Fixed Asset",
  "Other Asset",
  "Accounts Receivable",
  "Equity",
  "Expense",
  "Other Expense",
  "Cost of Goods Sold",
  "Accounts Payable",
  "Credit Card",
  "Long Term Liability",
  "Other Current Liability",
  "Income",
  "Other Income",
] as const;

type Ledger = {
  connectionId: string;
  connector: string;
  accountName: string | null;
  status: string;
  lastSyncAt: string | null;
  accounts: {
    id: string;
    externalId: string;
    name: string;
    fullName: string;
    number: string | null;
    kind: string;
    type: string;
    subType: string | null;
    description: string | null;
    parentExternalId: string | null;
    active: boolean;
    syncToken: string | null;
    notes: { note: string; source: string }[];
  }[];
  dimensions: {
    id: string;
    kind: "class" | "location";
    externalId: string;
    name: string;
    fullName: string;
    parentExternalId: string | null;
    active: boolean;
    syncToken: string | null;
  }[];
};
type Account = Ledger["accounts"][number];
type Dimension = Ledger["dimensions"][number];

/** What is being added or changed: the tool, its fields as the form holds them, and what it was. */
type Draft =
  | { what: "account"; record: Account | null; fields: Record<string, string> }
  | { what: "class" | "location"; record: Dimension | null; fields: Record<string, string> };

const TOOL = {
  account: { create: "qbo.account.create", update: "qbo.account.update" },
  class: { create: "qbo.class.create", update: "qbo.class.update" },
  location: { create: "qbo.location.create", update: "qbo.location.update" },
} as const;

export function OpsClientLedgerScreen() {
  const { clientId = "" } = useParams();
  return (
    <ClientFrame clientId={clientId}>
      <ClientLedger clientId={clientId} />
    </ClientFrame>
  );
}

export function ClientLedger({ clientId }: { clientId: string }) {
  const state = useApi(apiRoutes.opsClientLedger, { params: { id: clientId } });
  return (
    <Loaded state={state} skeleton={<SkeletonCard lines={6} />}>
      {(data) => {
        const ledgers = data.ledgers as Ledger[];
        if (ledgers.length === 0) {
          return (
            <EmptyState>
              No chart of accounts yet: the client connects QuickBooks, and its first sync brings
              the accounts, classes and locations.
            </EmptyState>
          );
        }
        return (
          <div className="flex flex-col gap-6" data-testid="ops-ledger">
            {ledgers.map((l) => (
              <LedgerCard
                key={l.connectionId}
                clientId={clientId}
                ledger={l}
                onChange={state.reload}
              />
            ))}
          </div>
        );
      }}
    </Loaded>
  );
}

function LedgerCard({
  clientId,
  ledger,
  onChange,
}: {
  clientId: string;
  ledger: Ledger;
  onChange: () => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const accounts = ledger.accounts.filter((a) => showInactive || a.active);
  const dims = (kind: "class" | "location") =>
    ledger.dimensions.filter((d) => d.kind === kind && (showInactive || d.active));
  const nameOf = (externalId: string | null) =>
    ledger.accounts.find((a) => a.externalId === externalId)?.fullName ?? null;
  const connected = ledger.status === "connected";
  return (
    <Card
      pad
      testId="ops-ledger-card"
      title={ledger.accountName ?? "QuickBooks"}
      meta={
        <span className="text-sm text-ink-muted">
          {ledger.lastSyncAt ? `Synced ${shortTime(ledger.lastSyncAt)}` : "Not synced yet"}
        </span>
      }
    >
      <p className="mb-3 text-sm text-ink-muted">
        The company's ledger in QuickBooks. Every change here is written to QuickBooks once you sign
        it, and applies to everything already booked there.
      </p>
      {!connected ? (
        <p className="mb-3 text-sm text-ink">
          <Badge tone="warning">Not connected</Badge> The client signs in to QuickBooks again before
          anything changes.
        </p>
      ) : null}
      <label className="mb-3 flex items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          checked={showInactive}
          onChange={(e) => setShowInactive(e.target.checked)}
        />
        Show inactive
      </label>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionLabel>Accounts</SectionLabel>
        <Button
          size="sm"
          disabled={!connected}
          data-testid="ops-ledger-add-account"
          onClick={() =>
            setDraft({ what: "account", record: null, fields: { accountType: "Expense" } })
          }
        >
          Add an account
        </Button>
      </div>
      <ul className="mb-4 flex flex-col divide-y divide-line" data-testid="ops-ledger-accounts">
        {accounts.map((a) => (
          <li
            key={a.id}
            className="flex flex-wrap items-start justify-between gap-3 py-2"
            data-testid="ops-ledger-account"
          >
            <div className="min-w-0">
              <p className="text-ink">
                <b>{[a.number, a.fullName].filter(Boolean).join(" ")}</b>{" "}
                <span className="text-sm text-ink-muted">
                  {[a.type, a.subType].filter(Boolean).join(" · ")}
                </span>{" "}
                {a.active ? null : <Badge>Inactive</Badge>}
              </p>
              {a.description ? <p className="text-sm text-ink-muted">{a.description}</p> : null}
              {a.notes[0] ? <p className="text-sm text-ink">{a.notes[0].note}</p> : null}
            </div>
            <Button
              size="sm"
              disabled={!connected || !a.syncToken}
              onClick={() => setDraft({ what: "account", record: a, fields: {} })}
            >
              Change
            </Button>
          </li>
        ))}
      </ul>

      {(["class", "location"] as const).map((kind) => (
        <div key={kind} className="mb-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <SectionLabel>{kind === "class" ? "Classes" : "Locations"}</SectionLabel>
            <Button
              size="sm"
              disabled={!connected}
              data-testid={`ops-ledger-add-${kind}`}
              onClick={() => setDraft({ what: kind, record: null, fields: {} })}
            >
              {kind === "class" ? "Add a class" : "Add a location"}
            </Button>
          </div>
          {dims(kind).length === 0 ? (
            <p className="text-sm text-ink-muted">None.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {dims(kind).map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-3 py-2">
                  <span className="text-ink">
                    {d.fullName} {d.active ? null : <Badge>Inactive</Badge>}
                  </span>
                  <Button
                    size="sm"
                    disabled={!connected || !d.syncToken}
                    onClick={() => setDraft({ what: kind, record: d, fields: {} })}
                  >
                    Change
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}

      {draft ? (
        <ChangeForm
          clientId={clientId}
          connectionId={ledger.connectionId}
          draft={draft}
          parents={
            draft.what === "account"
              ? ledger.accounts
                  .filter((a) => a.active && a.id !== draft.record?.id)
                  .map((a) => ({ id: a.externalId, name: a.fullName, type: a.type }))
              : ledger.dimensions
                  .filter((d) => d.kind === draft.what && d.active && d.id !== draft.record?.id)
                  .map((d) => ({ id: d.externalId, name: d.fullName, type: null }))
          }
          parentName={(id) =>
            draft.what === "account"
              ? nameOf(id)
              : (ledger.dimensions.find((d) => d.externalId === id)?.fullName ?? null)
          }
          onClose={() => setDraft(null)}
          onDone={() => {
            setDraft(null);
            onChange();
          }}
        />
      ) : null}
    </Card>
  );
}

const WORD = { account: "account", class: "class", location: "location" } as const;

function ChangeForm({
  clientId,
  connectionId,
  draft,
  parents,
  parentName,
  onClose,
  onDone,
}: {
  clientId: string;
  connectionId: string;
  draft: Draft;
  parents: { id: string; name: string; type: string | null }[];
  parentName: (id: string | null) => string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const client = useApiClient();
  const isAccount = draft.what === "account";
  const record = draft.record;
  const account = isAccount ? (record as Account | null) : null;
  const start: Record<string, string> = record
    ? {
        name: record.name,
        parentId: record.parentExternalId ?? "",
        active: record.active ? "yes" : "no",
        ...(account
          ? {
              accountType: account.type,
              accountSubType: account.subType ?? "",
              number: account.number ?? "",
              description: account.description ?? "",
            }
          : {}),
      }
    : {
        name: "",
        parentId: "",
        ...(isAccount
          ? { accountType: "Expense", number: "", description: "", accountSubType: "" }
          : {}),
      };
  const [fields, setFields] = useState<Record<string, string>>({ ...start, ...draft.fields });
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [requestId] = useState(() => crypto.randomUUID());
  const set = (k: string, v: string) => setFields((f) => ({ ...f, [k]: v }));

  // What changes, field by field: [label, now, after].
  const changes: [string, string, string][] = [];
  const compare = (label: string, key: string, show = (v: string) => v) => {
    const now = start[key] ?? "";
    const after = fields[key] ?? "";
    if (record ? now !== after : after !== "")
      changes.push([label, record ? show(now) : "", show(after)]);
  };
  compare("Name", "name");
  if (isAccount) {
    compare("Type", "accountType");
    compare("Detail type", "accountSubType");
    compare("Number", "number");
    compare("Description", "description");
  }
  compare("Under", "parentId", (v) => (v ? (parentName(v) ?? v) : "Top level"));
  if (record) compare("Active", "active");

  function input(): Record<string, unknown> {
    const v = (k: string) => fields[k]?.trim() ?? "";
    if (!record) {
      return {
        name: v("name"),
        ...(v("parentId") ? { parentId: v("parentId") } : {}),
        ...(isAccount
          ? {
              accountType: v("accountType"),
              ...(v("accountSubType") ? { accountSubType: v("accountSubType") } : {}),
              ...(v("number") ? { number: v("number") } : {}),
              ...(v("description") ? { description: v("description") } : {}),
            }
          : {}),
      };
    }
    const out: Record<string, unknown> = { id: record.externalId, syncToken: record.syncToken };
    const changed = (k: string) => (start[k] ?? "") !== (fields[k] ?? "");
    if (changed("name")) out.name = v("name");
    if (changed("parentId")) out.parentId = v("parentId") || null;
    if (changed("active")) out.active = fields.active === "yes";
    if (isAccount) {
      if (changed("accountType")) out.accountType = v("accountType");
      if (changed("accountSubType") && v("accountSubType"))
        out.accountSubType = v("accountSubType");
      if (changed("number")) out.number = v("number") || null;
      if (changed("description")) out.description = v("description") || null;
    }
    return out;
  }

  async function sign() {
    setBusy(true);
    setProblem(null);
    try {
      const res = await client.call(apiRoutes.opsClientLedgerChange, {
        params: { id: clientId },
        body: {
          connectionId,
          tool: record ? TOOL[draft.what].update : TOOL[draft.what].create,
          input: input(),
          requestId,
        },
      });
      if (res.status === "failed") setProblem(res.error ?? "QuickBooks didn't take the change");
      else onDone();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const title = record
    ? `Change the ${WORD[draft.what]} ${record.fullName}`
    : `Add ${draft.what === "account" ? "an" : "a"} ${WORD[draft.what]}`;
  return (
    <div
      className="mt-4 flex flex-col gap-3 rounded-md border border-line p-4"
      data-testid="ops-ledger-form"
    >
      <p className="font-medium text-ink">{title}</p>
      {!reviewing ? (
        <>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <input
              className="ds-input"
              aria-label="Name"
              placeholder="Name"
              maxLength={100}
              data-testid="ops-ledger-name"
              value={fields.name ?? ""}
              onChange={(e) => set("name", e.target.value)}
            />
            {isAccount ? (
              <>
                <select
                  className="ds-select"
                  aria-label="Type"
                  data-testid="ops-ledger-type"
                  value={fields.accountType ?? ""}
                  onChange={(e) => set("accountType", e.target.value)}
                >
                  {ACCOUNT_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <input
                  className="ds-input"
                  aria-label="Detail type"
                  placeholder="Detail type (QuickBooks' own, optional)"
                  value={fields.accountSubType ?? ""}
                  onChange={(e) => set("accountSubType", e.target.value)}
                />
                <input
                  className="ds-input"
                  aria-label="Number"
                  placeholder="Number (optional)"
                  maxLength={20}
                  value={fields.number ?? ""}
                  onChange={(e) => set("number", e.target.value)}
                />
                <input
                  className="ds-input md:col-span-2"
                  aria-label="Description"
                  placeholder="Description (optional)"
                  maxLength={100}
                  value={fields.description ?? ""}
                  onChange={(e) => set("description", e.target.value)}
                />
              </>
            ) : null}
            <select
              className="ds-select"
              aria-label="Under"
              value={fields.parentId ?? ""}
              onChange={(e) => set("parentId", e.target.value)}
            >
              <option value="">Top level</option>
              {parents
                .filter((p) => !isAccount || p.type === fields.accountType)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
            {record ? (
              <select
                className="ds-select"
                aria-label="Active"
                value={fields.active ?? "yes"}
                onChange={(e) => set("active", e.target.value)}
              >
                <option value="yes">Active</option>
                <option value="no">Inactive</option>
              </select>
            ) : null}
          </div>
          <div className="flex justify-end gap-2">
            <Button size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              data-testid="ops-ledger-review"
              disabled={changes.length === 0 || !(fields.name ?? "").trim()}
              onClick={() => setReviewing(true)}
            >
              Review the change
            </Button>
          </div>
        </>
      ) : (
        <>
          <table className="text-sm" data-testid="ops-ledger-review-table">
            <tbody>
              {changes.map(([label, now, after]) => (
                <tr key={label}>
                  <td className="pr-4 text-ink-muted">{label}</td>
                  {record ? (
                    <td className="pr-4 text-ink-muted line-through">{now || "—"}</td>
                  ) : null}
                  <td className="text-ink">{after || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-sm text-ink">
            <Badge tone="person">Your signature</Badge> This is written to the client's QuickBooks
            once, as you sign it, and recorded with your name.
          </p>
          {problem ? (
            <p className="text-sm text-risk" data-testid="ops-ledger-problem">
              {problem}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button size="sm" disabled={busy} onClick={() => setReviewing(false)}>
              Back
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              data-testid="ops-ledger-sign"
              onClick={() => void sign()}
            >
              Sign and save
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
