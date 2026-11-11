// Wave 6 (docs/plan.md §1.86 "Run audit (wave 6)"): one run's whole trail as one file for an
// auditor. The data is the back office's run view (`opsRunDetail`) with every step's checks, the
// owner's checks and decisions, tool calls, writes, inbox items and AI calls placed under the step
// they belong to, and the run's audit marks. AI calls carry their model, tokens and cost; their
// full prompt and answer only when the operator asks for them. Two renderings of the same data:
// JSON (core's `RunExport`) and a self-contained HTML page that prints to PDF.
//
// Never a secret (invariant 13): nothing here reads the vault, and before rendering every field
// named like a secret is replaced and card numbers are redacted, as the model-call view does.

import {
  conferOf,
  FORBIDDEN_SECRET_FIELD,
  type ModelCallBody,
  type OpsModelCall,
  type OwnerCheckView,
  type RouteResponse,
  type RunAuditState,
  RunExport,
  type RunExportStep,
  redactCardNumbersDeep,
  type routes,
  shortRunId,
  type TimelineChecks,
} from "@countersign/core";
import type { stepRun } from "@countersign/db";
import { stepFinder, stepOfRow } from "../routes/run-checks";

type RunView = RouteResponse<typeof routes.opsRun>;
type StepRow = typeof stepRun.$inferSelect;

/** What the export is built from: the run view and what it adds. */
export interface ExportInput {
  view: RunView;
  stepRows: readonly StepRow[];
  /** The timeline's check fields by step row id (`timelineChecks`). */
  checks: ReadonlyMap<string, TimelineChecks>;
  workflow: Parameters<typeof stepFinder>[0];
  ownerChecks: readonly OwnerCheckView[];
  audit: RunAuditState;
  modelCalls: readonly (OpsModelCall & { body?: ModelCallBody | null })[];
  client: { id: string; name: string };
  exportedBy: { id: string; email: string; name: string | null };
  exportedAt: Date;
  includesModelCalls: boolean;
}

const REDACTED = "[redacted]";

/** Every field named like a secret replaced, and card numbers redacted, all the way down. */
export function redactForExport<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v as Record<string, unknown>)) {
        out[k] = FORBIDDEN_SECRET_FIELD.test(k) ? REDACTED : walk(inner);
      }
      return out;
    }
    return v;
  };
  return redactCardNumbersDeep(walk(value)) as T;
}

/** The step row an item, a write or a decision belongs to: its own node, else the longest prefix. */
function rowOfNode(rows: readonly StepRow[], node: string | null): StepRow | undefined {
  if (!node) return undefined;
  let best: StepRow | undefined;
  for (const r of rows) {
    if (node === r.nodeId || node.startsWith(`${r.nodeId}:`)) {
      if (!best || r.nodeId.length > best.nodeId.length) best = r;
    }
  }
  return best;
}

function itemNode(payload: Record<string, unknown>): string | null {
  if (typeof payload.nodeId === "string") return payload.nodeId;
  if (typeof payload.stepId === "string") return payload.stepId;
  return null;
}

/** The export's data (core's `RunExport`), redacted. */
export function buildRunExport(input: ExportInput): RunExport {
  const { view } = input;
  const rows = input.stepRows;
  const find = stepFinder(input.workflow);
  const placed = new Set<string>();
  const byRow = <T>(list: readonly T[], rowOf: (t: T) => StepRow | undefined) => {
    const out = new Map<string, T[]>();
    const left: T[] = [];
    for (const t of list) {
      const r = rowOf(t);
      if (!r) {
        left.push(t);
        continue;
      }
      out.set(r.id, [...(out.get(r.id) ?? []), t]);
    }
    return { out, left };
  };
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const actions = byRow(view.actions, (a) => (a.stepRunId ? rowById.get(a.stepRunId) : undefined));
  const actionStep = new Map(view.actions.map((a) => [a.inboxItemId, a.stepRunId]));
  const inbox = byRow(view.inbox, (i) => {
    const viaAction = actionStep.get(i.id);
    if (viaAction) return rowById.get(viaAction);
    return rowOfNode(rows, itemNode(i.payload));
  });
  const decisions = byRow(view.oversight ?? [], (d) => rowById.get(d.stepRunId));
  const calls = byRow(input.modelCalls, (m) =>
    m.stepRunId ? rowById.get(m.stepRunId) : undefined,
  );
  const tools = byRow(view.toolCalls, (t) => rowById.get(t.stepRunId));
  const steps: RunExportStep[] = view.steps.map((s) => {
    placed.add(s.id);
    const row = rowById.get(s.id);
    const def = row ? stepOfRow(find, row.nodeId) : undefined;
    const checks = input.checks.get(s.id) ?? null;
    // The back office reads a second check's note (the portal never does).
    const confer = row ? conferOf(row) : null;
    const withNote =
      checks?.confer && confer
        ? { ...checks, confer: { ...checks.confer, note: confer.note } }
        : checks;
    return {
      ...s,
      name: def && "name" in def && typeof def.name === "string" ? def.name : null,
      checks: withNote,
      ownerChecks: input.ownerChecks.filter((c) => c.nodeId === s.nodeId),
      toolCalls: tools.out.get(s.id) ?? [],
      actions: actions.out.get(s.id) ?? [],
      inbox: inbox.out.get(s.id) ?? [],
      decisions: decisions.out.get(s.id) ?? [],
      modelCalls: [...(calls.out.get(s.id) ?? [])],
    };
  });
  const tokensIn = input.modelCalls.reduce((n, m) => n + m.tokensIn, 0);
  const tokensOut = input.modelCalls.reduce((n, m) => n + m.tokensOut, 0);
  const data: RunExport = {
    format: "mezonas.run-export",
    formatVersion: 1,
    exportedAt: input.exportedAt.toISOString(),
    exportedBy: input.exportedBy,
    includesModelCalls: input.includesModelCalls,
    client: input.client,
    agent: view.agent,
    agentVersion: { id: view.run.agentVersionId, number: view.version },
    workflow: { slug: view.run.workflowSlug, name: view.workflow?.name ?? null },
    run: view.run,
    steps,
    unplaced: {
      inbox: inbox.left,
      actions: actions.left,
      decisions: decisions.left,
      modelCalls: [...calls.left],
    },
    totals: {
      costUsd: view.run.costUsd,
      tokensIn,
      tokensOut,
      modelCalls: input.modelCalls.length,
    },
    sourceNames: view.sourceNames ?? {},
    audit: input.audit,
  };
  return RunExport.parse(redactForExport(data));
}

/** The JSON file's bytes. */
export function runExportJson(data: RunExport): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(`${JSON.stringify(data, null, 2)}\n`));
}

// ── The printable page ──────────────────────────────────────────────────────────────────────────

const esc = (v: unknown): string =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const when = (iso: string | null | undefined) =>
  iso ? esc(iso.replace("T", " ").slice(0, 19)) : "—";

function json(v: unknown): string {
  if (v === null || v === undefined) return '<p class="muted">None</p>';
  return `<pre>${esc(JSON.stringify(v, null, 2))}</pre>`;
}

function dl(pairs: [string, string][]): string {
  return `<dl>${pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>`;
}

function table(head: string[], body: string[][]): string {
  if (body.length === 0) return "";
  return `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${body
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

function checksHtml(checks: TimelineChecks | null): string {
  if (!checks) return "";
  const lines: string[] = [];
  if (checks.outcome) lines.push(`Outcome: ${esc(checks.outcome)}`);
  if (checks.route) {
    const why = checks.route.because.map((b) => `${esc(b.label)} was ${esc(b.outcome)}`).join("; ");
    lines.push(`Route taken: ${esc(checks.route.path ?? "otherwise")}${why ? ` (${why})` : ""}`);
  }
  if (checks.carriedOn) lines.push("Failed, and the run carried on past it");
  if (checks.confer) {
    const c = checks.confer;
    lines.push(
      `Second check (${c.reviewer === "ai" ? "AI" : esc(c.name ?? c.who ?? "a person")}): ${esc(c.verdict)}${c.note ? `: ${esc(c.note)}` : ""}`,
    );
  }
  if (checks.approval) {
    for (const a of checks.approval.approvers) {
      lines.push(`Approval (${esc(checks.approval.mode)}): ${esc(JSON.stringify(a))}`);
    }
  }
  if (checks.noAnswer) lines.push(`Nobody answered: ${esc(checks.noAnswer)}`);
  if (checks.urgent) {
    lines.push(
      `Urgent notice: ${esc(checks.urgent.state)}${checks.urgent.seenAt ? ` at ${when(checks.urgent.seenAt)}` : ""}${checks.urgent.dueAt ? `, due ${when(checks.urgent.dueAt)}` : ""}`,
    );
  }
  return lines.length
    ? `<h4>Checks</h4><ul>${lines.map((l) => `<li>${l}</li>`).join("")}</ul>`
    : "";
}

function stepHtml(s: RunExportStep, n: number, withBodies: boolean): string {
  const parts: string[] = [];
  parts.push(
    `<h3>${n}. ${esc(s.name ?? s.nodeId)} <span class="tag">${esc(s.nodeType)}</span> <span class="tag">${esc(s.status)}</span></h3>`,
  );
  parts.push(
    dl([
      ["Step", `<code>${esc(s.nodeId)}</code>`],
      ["Started", when(s.startedAt)],
      ["Finished", when(s.finishedAt)],
      ["Outcome", esc(s.outcome ?? "—")],
      ["Summary", esc(s.summary ?? "—")],
      ["Models", esc((s.models ?? []).join(", ") || "—")],
      ["Cost", `$${esc(s.costUsd)} (${s.tokensIn} in, ${s.tokensOut} out)`],
    ]),
  );
  if (s.ownerChecks.length > 0) {
    parts.push(
      `<h4>Owner's check</h4><ul>${s.ownerChecks.map((c) => `<li>Attempt ${c.attempt}: ${esc(c.words)}</li>`).join("")}</ul>`,
    );
  }
  parts.push(checksHtml(s.checks));
  parts.push("<h4>Input</h4>", json(s.input), "<h4>Output</h4>", json(s.output));
  if (s.toolCalls.length > 0) {
    parts.push(
      "<h4>Tool calls</h4>",
      table(
        ["Tool", "Status", "Took", "Input", "Output"],
        s.toolCalls.map((t) => [
          `<code>${esc(t.tool)}</code>`,
          esc(t.status),
          t.durationMs === null ? "—" : `${t.durationMs} ms`,
          json(t.input),
          json(t.output),
        ]),
      ),
    );
  }
  if (s.actions.length > 0) {
    parts.push(
      "<h4>Changes to the client's tools</h4>",
      table(
        ["Tool", "Status", "Approved by", "Before", "Change", "Result"],
        s.actions.map((a) => [
          `<code>${esc(a.tool)}</code>`,
          esc(a.status),
          a.approvedBy ? `${esc(a.approvedBy)}<br>${when(a.approvedAt)}` : "—",
          json(a.before),
          json(a.editedInput ?? a.input),
          json(a.result ?? a.error),
        ]),
      ),
    );
  }
  if (s.inbox.length > 0) {
    parts.push(
      "<h4>Approvals, questions and deadlines</h4>",
      table(
        ["Item", "Kind", "Status", "Due", "Resolved", "Resolution"],
        s.inbox.map((i) => [
          esc(i.title),
          esc(i.kind),
          esc(i.status),
          when(i.dueAt),
          i.resolvedAt
            ? `${when(i.resolvedAt)}${i.resolvedBy ? `<br>${esc(i.resolvedBy)}` : ""}`
            : "—",
          json(i.resolution),
        ]),
      ),
    );
  }
  if (s.decisions.length > 0) {
    parts.push(
      "<h4>Owner's decisions</h4>",
      table(
        ["#", "Why", "Decision", "Note", "Sources", "Model", "Cost"],
        s.decisions.map((d) => [
          String(d.seq),
          esc(d.cause),
          esc(d.action),
          esc(d.note),
          esc(d.sources.join(", ") || "—"),
          esc(d.model),
          `$${esc(d.costUsd)}`,
        ]),
      ),
    );
  }
  if (s.modelCalls.length > 0) {
    parts.push(
      "<h4>AI calls</h4>",
      table(
        ["Model", "Tokens in", "Tokens out", "Cost", "Stopped", "At"],
        s.modelCalls.map((m) => [
          esc(m.model),
          String(m.tokensIn),
          String(m.tokensOut),
          `$${esc(m.costUsd)}`,
          esc(m.stopReason ?? "—"),
          when(m.createdAt),
        ]),
      ),
    );
    if (withBodies) {
      for (const m of s.modelCalls) {
        parts.push(
          `<details open><summary>${esc(m.model)} at ${when(m.createdAt)}: prompt and answer</summary>${
            m.body
              ? `<h5>Prompt</h5>${json(m.body.request)}<h5>Answer</h5>${json(m.body.answer)}`
              : '<p class="muted">Not stored.</p>'
          }</details>`,
        );
      }
    }
  }
  return `<section class="step">${parts.join("")}</section>`;
}

// Values from the Mezonas design system's tokens (packages/design-system/tokens.css): the export is
// one file with nothing to load, so they are written out here.
const STYLE = `
:root{--paper:#F4F5F3;--surface:#FFFFFF;--ink:#151A21;--ink-muted:#535B65;--line:#DCDFE2;--slate:#23415E;--risk:#A3302A;--positive:#1F6B4A;--copper:#9A4D27;color-scheme:light}
@media (prefers-color-scheme: dark){:root{--paper:#0F1318;--surface:#171C23;--ink:#E6E9EC;--ink-muted:#9DA5AF;--line:#2A313A;--slate:#8FB0D2;--risk:#E8807A;--positive:#7CC4A0;--copper:#D9895E;color-scheme:dark}}
body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.5 "Geist",ui-sans-serif,system-ui,sans-serif}
main{max-width:1000px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}
h3{font-size:15px;margin:0 0 8px}h4{font-size:13px;margin:14px 0 4px;color:var(--ink-muted)}h5{font-size:12px;margin:8px 0 2px}
.muted{color:var(--ink-muted)}.tag{font-size:12px;font-weight:400;border:1px solid var(--line);border-radius:6px;padding:0 6px;color:var(--ink-muted)}
.step{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:12px 0;break-inside:avoid-page}
dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 16px;margin:0}dt{color:var(--ink-muted)}dd{margin:0;overflow-wrap:anywhere}
pre{font:12px/1.4 "Geist Mono",ui-monospace,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere;margin:0;background:var(--paper);border:1px solid var(--line);border-radius:6px;padding:6px 8px}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{border:1px solid var(--line);padding:4px 6px;text-align:left;vertical-align:top}
.problem{color:var(--risk)}.right{color:var(--positive)}.person{color:var(--copper)}
@media print{:root{--paper:#FFFFFF;--surface:#FFFFFF;--ink:#151A21;--ink-muted:#535B65;--line:#DCDFE2;--risk:#A3302A;--positive:#1F6B4A;--copper:#9A4D27;color-scheme:light}main{max-width:none;padding:0}details>summary{list-style:none}}
`;

/** The printable page: self-contained (no script, no link), prints to PDF. */
export function runExportHtml(data: RunExport): Uint8Array<ArrayBuffer> {
  const r = data.run;
  const marks = data.audit.marks;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Run ${esc(shortRunId(r.id))}: audit trail</title><style>${STYLE}</style></head>
<body><main>
<h1>Run ${esc(shortRunId(r.id))}: audit trail</h1>
<p class="muted">${esc(data.client.name)} · ${esc(data.agent?.name ?? "Agent")} · exported ${when(data.exportedAt)} UTC by ${esc(data.exportedBy.name ?? data.exportedBy.email)}${data.includesModelCalls ? " · with AI prompts and answers" : ""}</p>
<h2>The run</h2>
${dl([
  ["Run", `<code>${esc(r.id)}</code>`],
  ["Client", esc(data.client.name)],
  ["Agent", esc(data.agent ? `${data.agent.name} (${data.agent.slug})` : "—")],
  ["Version", `${esc(data.agentVersion.number ?? "—")} <code>${esc(data.agentVersion.id)}</code>`],
  ["Workflow", esc(data.workflow.name ?? data.workflow.slug)],
  ["Mode", esc(r.mode)],
  ["Status", esc(r.status)],
  ["Created", when(r.createdAt)],
  ["Started", when(r.startedAt)],
  ["Finished", when(r.finishedAt)],
  [
    "Cost",
    `$${esc(data.totals.costUsd)} · ${data.totals.modelCalls} AI calls · ${data.totals.tokensIn} tokens in, ${data.totals.tokensOut} out`,
  ],
])}
<h4>Trigger</h4>${json(r.trigger)}
${r.error ? `<h4>Error</h4>${json(r.error)}` : ""}
<h2>Audit</h2>
${
  data.audit.queued
    ? `<p>Queued for audit: ${esc(data.audit.queued.reason)} at ${when(data.audit.queued.createdAt)}.</p>`
    : '<p class="muted">Not in the audit queue.</p>'
}
${
  marks.length > 0
    ? table(
        ["When", "Who", "Mark", "Note"],
        marks.map((m) => [
          when(m.createdAt),
          esc(m.markedBy.name ?? m.markedBy.email),
          `<span class="${m.verdict === "problem" ? "problem" : "right"}">${m.verdict === "problem" ? "Problem" : "Looks right"}</span>`,
          esc(m.note ?? ""),
        ]),
      )
    : '<p class="muted">No marks yet.</p>'
}
<h2>Steps, in the order they ran</h2>
${data.steps.map((s, i) => stepHtml(s, i + 1, data.includesModelCalls)).join("\n")}
${
  data.unplaced.inbox.length + data.unplaced.actions.length + data.unplaced.decisions.length > 0
    ? `<h2>Not tied to a step</h2>${json(data.unplaced)}`
    : ""
}
</main></body></html>
`;
  return new Uint8Array(new TextEncoder().encode(html));
}
