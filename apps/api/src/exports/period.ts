// The accountant export (docs/plan.md §1.36), built in the request: it covers a period of at most
// a year and is capped, so it fits in one Worker request (the audit export streams: W2-G).

import type { ObjectStore } from "@countersign/connectors";
import {
  type AuditPeriod,
  DECIMAL_RE,
  Decimal,
  type ExportFile,
  type ExportPeriod,
  isPlainObject,
  isUuid,
} from "@countersign/core";
import {
  agent,
  agentVersion,
  connection,
  document,
  externalAction,
  run,
  type Tx,
  tenant,
} from "@countersign/db";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { changeDisplay } from "../change-display";
import { HttpError, notFound } from "../http";
import type { Platform } from "../platform";
import { CSV_TYPE, type CsvValue, csvFile, documentPath, jsonCell } from "./csv";
import { emails } from "./tables";
import { zipSync } from "./zip";

/** The most changes one accountant export holds; a longer list needs a shorter period. */
export const ACCOUNTANT_MAX_CHANGES = 20_000;
/** The most document bytes one accountant ZIP holds (the request builds it in memory). */
export const ACCOUNTANT_MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;

export interface Period {
  start: Date;
  end: Date;
  timezone: string;
  clientName: string;
}

/**
 * The period's bounds: `from` 00:00 to the day after `to` 00:00, in the client's timezone.
 */
// DECISION: a period is whole days in the client's own timezone (`tenant.timezone`), as its
// accountant counts them, both ends included.
export async function periodOf(
  tx: Tx,
  tenantId: string,
  p: Pick<AuditPeriod, "from" | "to">,
): Promise<Period> {
  const [t] = await tx
    .select({ name: tenant.name, timezone: tenant.timezone })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  if (!t) throw notFound("client");
  const rows = await tx.execute<{ start: string; end: string }>(sql`select
    (extract(epoch from (${p.from}::date)::timestamp at time zone ${t.timezone}) * 1000)::bigint::text as start,
    (extract(epoch from (${p.to}::date + 1)::timestamp at time zone ${t.timezone}) * 1000)::bigint::text as end`);
  const r = [...rows][0];
  if (!r) throw new Error("no period");
  return {
    start: new Date(Number(r.start)),
    end: new Date(Number(r.end)),
    timezone: t.timezone,
    clientName: t.name,
  };
}

/** Every id (uuid) anywhere in a JSON value. */
function idsIn(value: unknown, out: Set<string>): Set<string> {
  if (typeof value === "string") {
    if (isUuid(value)) out.add(value.toLowerCase());
  } else if (Array.isArray(value)) {
    for (const v of value) idsIn(v, out);
  } else if (isPlainObject(value)) {
    for (const v of Object.values(value)) idsIn(v, out);
  }
  return out;
}

const MONEY_KEYS = ["total", "amount", "totalAmount", "TotalAmt", "Amount"] as const;

/**
 * The amount a change is about, when it says so plainly: a `{ amount, currency }` total or amount,
 * or a decimal total with a currency beside it. Otherwise blank: the change's JSON has the detail.
 */
// DECISION: amounts are read only from these top-level keys of the change, never guessed from
// nested lines; a number becomes a decimal string, and an unknown currency stays blank.
export function moneyOf(input: unknown): { amount: string; currency: string | null } | null {
  if (!isPlainObject(input)) return null;
  const currencyRef = input.CurrencyRef;
  const currency =
    typeof input.currency === "string"
      ? input.currency
      : isPlainObject(currencyRef) && typeof currencyRef.value === "string"
        ? currencyRef.value
        : null;
  for (const key of MONEY_KEYS) {
    const v = input[key];
    if (isPlainObject(v) && typeof v.amount === "string" && DECIMAL_RE.test(v.amount)) {
      return { amount: v.amount, currency: typeof v.currency === "string" ? v.currency : currency };
    }
    if (typeof v === "string" && DECIMAL_RE.test(v)) return { amount: v, currency };
    if (typeof v === "number" && Number.isFinite(v)) {
      return { amount: new Decimal(String(v)).toFixed(), currency };
    }
  }
  return null;
}

const CHANGES_HEADER = [
  "date",
  "status",
  "system",
  "account",
  "action",
  "tool",
  "amount",
  "currency",
  "signed_by",
  "signed_at",
  "executed_at",
  "run_id",
  "run_started_at",
  "service",
  "agent_version",
  "agent_version_id",
  "documents",
  "before",
  "change",
  "result",
  "error",
  "change_id",
] as const;

const RUNS_HEADER = [
  "run_id",
  "service",
  "agent_version",
  "agent_version_id",
  "workflow",
  "status",
  "started_at",
  "finished_at",
  "changes",
] as const;

interface AccountantInput {
  tx: Tx;
  tenantId: string;
  period: ExportPeriod;
  platform: Platform;
  objects: ObjectStore;
  now: Date;
}

/**
 * The accountant export: each change made to the client's tools in the period (an external
 * action, with its tool, the record before, the change and the result, who signed it and when,
 * its run and agent version, and the documents it rests on by file name), the runs, and with
 * `format=zip` those documents and a README.
 */
export async function accountantExport(
  input: AccountantInput,
): Promise<ExportFile & { changes: number }> {
  const { tx, tenantId, period: p, platform, objects } = input;
  const period = await periodOf(tx, tenantId, p);
  const at = sql`coalesce(${externalAction.executedAt}, ${externalAction.createdAt})`;
  const actions = await tx
    .select({
      a: externalAction,
      connector: connection.connector,
      account: connection.externalAccountId,
      runStartedAt: run.startedAt,
      trigger: run.trigger,
      runVersionId: run.agentVersionId,
      serviceName: agent.serviceName,
      agentName: agent.name,
    })
    .from(externalAction)
    .innerJoin(
      connection,
      and(
        eq(connection.id, externalAction.connectionId),
        eq(connection.tenantId, externalAction.tenantId),
      ),
    )
    .leftJoin(run, and(eq(run.id, externalAction.runId), eq(run.tenantId, externalAction.tenantId)))
    .leftJoin(agent, and(eq(agent.id, run.agentId), eq(agent.tenantId, run.tenantId)))
    .where(
      and(
        eq(externalAction.tenantId, tenantId),
        or(isNull(run.id), eq(run.mode, "live")),
        sql`${at} >= ${period.start.toISOString()} and ${at} < ${period.end.toISOString()}`,
      ),
    )
    .orderBy(asc(at), asc(externalAction.id))
    .limit(ACCOUNTANT_MAX_CHANGES + 1);
  if (actions.length > ACCOUNTANT_MAX_CHANGES) {
    throw new HttpError(
      413,
      "too_many",
      `more than ${ACCOUNTANT_MAX_CHANGES} changes in this period: choose a shorter one`,
    );
  }

  // The versions' numbers, read apart from their bundles.
  const versionIds = [
    ...new Set(
      actions
        .map((r) => r.a.agentVersionId ?? r.runVersionId)
        .filter((v): v is string => typeof v === "string"),
    ),
  ];
  const versions = new Map<string, number>();
  if (versionIds.length > 0) {
    for (const v of await tx
      .select({ id: agentVersion.id, version: agentVersion.version })
      .from(agentVersion)
      .where(and(eq(agentVersion.tenantId, tenantId), inArray(agentVersion.id, versionIds)))) {
      versions.set(v.id, v.version);
    }
  }

  // The documents each change rests on: those it names, and those of the transactions it names.
  const named = new Map<string, Set<string>>();
  const allIds = new Set<string>();
  for (const r of actions) {
    const ids = idsIn([r.a.input, r.a.before, r.a.result, r.trigger], new Set());
    ids.delete(r.a.id);
    named.set(r.a.id, ids);
    for (const id of ids) allIds.add(id);
  }
  const docs =
    allIds.size === 0
      ? []
      : await tx
          .select({
            id: document.id,
            filename: document.filename,
            transactionId: document.transactionId,
            storageKey: document.storageKey,
            sizeBytes: document.sizeBytes,
          })
          .from(document)
          .where(
            and(
              eq(document.tenantId, tenantId),
              or(inArray(document.id, [...allIds]), inArray(document.transactionId, [...allIds])),
            ),
          )
          .orderBy(document.id);
  const docsOf = (actionId: string) => {
    const ids = named.get(actionId) ?? new Set<string>();
    return docs.filter(
      (d) =>
        ids.has(d.id.toLowerCase()) || (d.transactionId && ids.has(d.transactionId.toLowerCase())),
    );
  };

  const signers = await emails(
    tx,
    actions.map((r) => r.a.approvedBy),
  );
  const changeRows: CsvValue[][] = actions.map((r) => {
    const a = r.a;
    const versionId = a.agentVersionId ?? r.runVersionId;
    const money = moneyOf(a.input);
    return [
      a.executedAt ?? a.createdAt,
      a.status,
      changeDisplay(platform, a.tool)?.connectorName ?? r.connector,
      r.account,
      platform.tools.get(a.tool)?.spec.description ?? a.tool,
      a.tool,
      money?.amount ?? null,
      money?.currency ?? null,
      a.approvedBy ? (signers.get(a.approvedBy) ?? a.approvedBy) : null,
      a.approvedAt,
      a.executedAt,
      a.runId,
      r.runStartedAt,
      r.serviceName ?? r.agentName,
      versionId ? (versions.get(versionId) ?? null) : null,
      versionId,
      docsOf(a.id).map(documentPath),
      jsonCell(a.before),
      jsonCell(a.input),
      jsonCell(a.result),
      jsonCell(a.error),
      a.id,
    ];
  });
  const stamp = `${p.from}-to-${p.to}`;
  if (p.format === "csv") {
    return {
      filename: `mezonas-changes-${stamp}.csv`,
      contentType: CSV_TYPE,
      bytes: csvFile(CHANGES_HEADER, changeRows),
      changes: actions.length,
    };
  }

  // Runs started in the period, and the runs of the changes in it.
  const runRows = await tx
    .select({
      r: run,
      serviceName: agent.serviceName,
      agentName: agent.name,
      version: agentVersion.version,
    })
    .from(run)
    .innerJoin(agent, and(eq(agent.id, run.agentId), eq(agent.tenantId, run.tenantId)))
    .leftJoin(
      agentVersion,
      and(eq(agentVersion.id, run.agentVersionId), eq(agentVersion.tenantId, run.tenantId)),
    )
    .where(
      and(
        eq(run.tenantId, tenantId),
        eq(run.mode, "live"),
        or(
          sql`${run.createdAt} >= ${period.start.toISOString()} and ${run.createdAt} < ${period.end.toISOString()}`,
          ...(actions.some((r) => r.a.runId)
            ? [
                inArray(
                  run.id,
                  actions.map((r) => r.a.runId).filter((v): v is string => v !== null),
                ),
              ]
            : []),
        ),
      ),
    )
    .orderBy(run.createdAt, run.id)
    .limit(ACCOUNTANT_MAX_CHANGES + 1);
  const changesPerRun = new Map<string, number>();
  for (const r of actions) {
    if (r.a.runId) changesPerRun.set(r.a.runId, (changesPerRun.get(r.a.runId) ?? 0) + 1);
  }
  const runsCsv = runRows.map(({ r, serviceName, agentName, version }) => [
    r.id,
    serviceName ?? agentName,
    version,
    r.agentVersionId,
    r.workflowSlug,
    r.status,
    r.startedAt,
    r.finishedAt,
    changesPerRun.get(r.id) ?? 0,
  ]);

  // The documents, once each, from the client's own prefix.
  const used = new Map<string, (typeof docs)[number]>();
  for (const r of actions) for (const d of docsOf(r.a.id)) used.set(d.id, d);
  const total = [...used.values()].reduce((n, d) => n + d.sizeBytes, 0);
  if (total > ACCOUNTANT_MAX_DOCUMENT_BYTES) {
    throw new HttpError(
      413,
      "too_large",
      "the documents for this period are too large for one download: choose a shorter period, or format=csv",
    );
  }
  const own = `tenants/${tenantId.toLowerCase()}/`;
  const files: { name: string; bytes: Uint8Array }[] = [];
  const missing: string[] = [];
  for (const d of used.values()) {
    const object = d.storageKey.startsWith(own) ? await objects.get(d.storageKey) : null;
    if (object) files.push({ name: documentPath(d), bytes: object.bytes });
    else missing.push(documentPath(d));
  }
  const readme = accountantReadme(period, p, actions.length, runsCsv.length, files.length, missing);
  return {
    filename: `mezonas-accountant-${stamp}.zip`,
    contentType: "application/zip",
    bytes: zipSync(
      [
        { name: "README.txt", bytes: new TextEncoder().encode(readme) },
        { name: "changes.csv", bytes: csvFile(CHANGES_HEADER, changeRows) },
        { name: "runs.csv", bytes: csvFile(RUNS_HEADER, runsCsv) },
        ...files,
      ],
      input.now,
    ),
    changes: actions.length,
  };
}

function accountantReadme(
  period: Period,
  p: ExportPeriod,
  changes: number,
  runs: number,
  documents: number,
  missing: string[],
): string {
  const lines = [
    `Mezonas accountant export for ${period.clientName}`,
    "",
    `Period: ${p.from} to ${p.to}, both days included, in ${period.timezone} time.`,
    "",
    `- changes.csv (${changes} rows): each change our services made or proposed in your tools`,
    "  in the period: the system and the tool, the amount where the change states one, who",
    "  signed it and when, the run and agent version that made it, the record before, the change",
    "  and the result (as JSON), and the documents it rests on. `status` is done for a change",
    "  that was made; rejected and failed changes are listed too.",
    `- runs.csv (${runs} rows): the runs that started in the period or made these changes.`,
    `- documents/ (${documents} files): the invoices and bills the changes rest on. The`,
    "  documents column of changes.csv names these files.",
    "",
    "Times are in UTC (2026-11-06T14:05:00.000Z). Money is a decimal number with its currency",
    "in the next column. A cell that starts with an apostrophe had one added, so a spreadsheet",
    "shows it as text.",
  ];
  if (missing.length > 0) {
    lines.push("", "These documents were not found in storage:", ...missing.map((m) => `- ${m}`));
  }
  lines.push("");
  return lines.join("\r\n");
}
