// Getting started's Try it on a real one (docs/setup-plan.md §6.2; docs/plan.md §1.206, SU5):
// stream SEE. A test run of the agent's latest version on one of the client's documents: it writes
// nothing and asks nobody (invariant 8: test runs never write; their writes are recorded as
// proposed, their notices go nowhere and their person steps are ours, never the client's). The
// run is started the way the router would start it on that document: the payload its document
// trigger carries, checked against the trigger's filter. The client reads a try only here, from
// the tries recorded on the agent, in the timeline's own words: never a prompt, the model's text,
// cost or the bundle (invariant 11). "Not right because…" files a request with the run as its
// source (invariant 10).
//
// Owner, §1.206 q2: any client user who can sign and sees the agent may start up to three tries
// per agent while it is being set up, one at a time.

import {
  existingBundle,
  latestVersion,
  type RegistryContext,
  snapshotSharedSkills,
  validateForPublish,
} from "@countersign/agents";
import {
  type AgentBundle,
  allTriggers,
  checkKindOf,
  clientLabel,
  evaluateRules,
  isPlainObject,
  isUuid,
  LEAD_ASSIGNEE,
  moneyWords,
  PeopleBindings,
  processes,
  type Rules,
  SETUP_TRIES_MAX,
  type Step,
  type StoredTry,
  shownOnTimeline,
  stepStateLabel,
  type TryCandidate,
  type TryStep,
  type TryVerdictBody,
  type TryView,
} from "@countersign/core";
import {
  agentVersion,
  appUser,
  docExtraction,
  docLine,
  document,
  membership,
  run,
  stepRun,
  type Tx,
} from "@countersign/db";
import { duplicateOfMeta } from "@countersign/documents";
import { leadDisplayName, leadOf } from "@countersign/threads";
import { type RunRequest, requestRun } from "@countersign/workflows";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { ensureSeesDocument } from "../assigned";
import { HttpError, notFound } from "../http";
import { summaryAfterLabel } from "../routes/portal";
import { stepFinder, stepOfRow, type TimelineStepDef } from "../routes/run-checks";
import { createRunRow } from "../runs/dispatch";
import { createIssue } from "../work/issues";
import {
  type AgentRow,
  beingSetUp,
  guideOf,
  refuseViewer,
  seeAgent,
  triesOf,
  writeGuide,
} from "./see-agent";
import type { SeeInput } from "./walkthrough";

type DocRow = typeof document.$inferSelect;
type RunRow = typeof run.$inferSelect;
type AnyWorkflow = AgentBundle["workflows"][number];

/** Candidates shown, newest first. */
const CANDIDATES_MAX = 5;
/** Recent documents looked at to find them. */
const CANDIDATES_SCANNED = 30;

// ── How the agent starts on a document ───────────────────────────────────────────────────────

/** A way one of the agent's workflows starts on a document. */
interface DocumentStart {
  slug: string;
  on: "document.received" | "document.extracted" | "manual";
  filter: Rules | undefined;
  /** A manual trigger's input properties (it takes a document when one is `documentId`). */
  fields: string[];
}

/**
 * The workflows (on, in order) that start on a document: an event trigger on `document.received`
 * or `document.extracted`, or a manual trigger whose input has a `documentId`.
 */
// DECISION: a manual trigger takes a document only when its input schema has a `documentId`
// property; the try gives it that id and, where the schema has them, the document's filename,
// type, source and sha256. Any other manual input has no document to fill it from, so an agent
// that starts only that way has no candidates.
export function documentStarts(bundle: Pick<AgentBundle, "workflows">): DocumentStart[] {
  const out: DocumentStart[] = [];
  for (const w of bundle.workflows as AnyWorkflow[]) {
    if (w.enabled === false) continue;
    for (const t of allTriggers(w.workflow)) {
      const on = t.on;
      if (
        on.type === "event" &&
        (on.event === "document.received" || on.event === "document.extracted")
      ) {
        out.push({ slug: w.slug, on: on.event, filter: on.filter, fields: [] });
      } else if (on.type === "manual") {
        const props = isPlainObject(on.input) ? on.input.properties : undefined;
        const fields = isPlainObject(props) ? Object.keys(props) : [];
        if (fields.includes("documentId")) {
          out.push({ slug: w.slug, on: "manual", filter: undefined, fields });
        }
      }
    }
  }
  return out;
}

interface Reading {
  id: string;
  header: unknown;
  total: string;
  currency: string;
  totalsMatch: boolean;
}

async function latestReading(tx: Tx, doc: DocRow): Promise<Reading | null> {
  const [x] = await tx
    .select({
      id: docExtraction.id,
      header: docExtraction.header,
      total: docExtraction.total,
      currency: docExtraction.currency,
      totalsMatch: docExtraction.totalsMatch,
    })
    .from(docExtraction)
    .where(and(eq(docExtraction.documentId, doc.id), eq(docExtraction.tenantId, doc.tenantId)))
    .orderBy(desc(docExtraction.createdAt), desc(docExtraction.id))
    .limit(1);
  return x ?? null;
}

/**
 * The trigger payload a start would get for this document, as the router would build it (the
 * event's own payload, or the manual input), or null when the start can't take it: not read yet
 * for `document.extracted`, or the trigger's filter says no.
 */
async function payloadFor(
  tx: Tx,
  doc: DocRow,
  start: DocumentStart,
  reading: Reading | null,
): Promise<Record<string, unknown> | null> {
  let payload: Record<string, unknown>;
  if (start.on === "document.received") {
    payload = {
      documentId: doc.id,
      source: doc.source,
      filename: doc.filename,
      mimeType: doc.mimeType,
      sha256: doc.sha256,
    };
  } else if (start.on === "document.extracted") {
    if (!reading) return null;
    const [lines] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(docLine)
      .where(and(eq(docLine.extractionId, reading.id), eq(docLine.tenantId, doc.tenantId)));
    payload = {
      documentId: doc.id,
      extractionId: reading.id,
      lineCount: lines?.n ?? 0,
      totalsValid: reading.totalsMatch,
    };
  } else {
    const all: Record<string, unknown> = {
      documentId: doc.id,
      filename: doc.filename,
      mimeType: doc.mimeType,
      source: doc.source,
      sha256: doc.sha256,
    };
    payload = Object.fromEntries(Object.entries(all).filter(([k]) => start.fields.includes(k)));
  }
  if (start.filter) {
    try {
      if (!evaluateRules(start.filter, { trigger: payload, steps: {} })) return null;
    } catch {
      return null;
    }
  }
  return payload;
}

/** The first start that takes this document, with its payload. */
export async function startFor(tx: Tx, doc: DocRow, starts: readonly DocumentStart[]) {
  const reading = await latestReading(tx, doc);
  for (const start of starts) {
    const payload = await payloadFor(tx, doc, start, reading);
    if (payload) return { start, payload, reading };
  }
  return null;
}

/** "Northside Lumber · $4,812.50" when the document was read, else its own name. */
export function titleOf(doc: DocRow, reading: Reading | null): string {
  const header = (reading?.header ?? null) as { vendorName?: unknown } | null;
  const vendor = typeof header?.vendorName === "string" ? header.vendorName.trim() : "";
  const amount = reading ? moneyWords(reading.total, reading.currency) : "";
  const title = vendor ? (amount ? `${vendor} · ${amount}` : vendor) : doc.filename;
  return title.slice(0, 300);
}

/** Who sent it, for a forwarded email (its From header, as the document's page shows it). */
function fromOf(doc: DocRow): string | null {
  const email = (doc.meta as { email?: { from?: unknown } } | null)?.email;
  return typeof email?.from === "string" && email.from.trim() ? email.from.trim() : null;
}

export async function sees(
  tx: Tx,
  input: Pick<SeeInput, "tenantId" | "sees">,
  documentId: string,
): Promise<boolean> {
  if (!input.sees) return true;
  try {
    await ensureSeesDocument(tx, input.tenantId, documentId, input.sees);
    return true;
  } catch {
    return false;
  }
}

async function versionToTry(tx: Tx, row: AgentRow) {
  const v = await latestVersion(tx, row.id);
  return v && v.tenantId === row.tenantId ? v : null;
}

/**
 * What the agent can be tried on: the client's most recent documents (at most five) that one of
 * its workflows starts on, newest first. Empty when it doesn't start from a document.
 */
// DECISION: a document already known as a copy of another (`duplicateOf`) or whose reading failed
// is never offered; a person limited to some agents sees only the documents those agents touched.
export async function tryCandidates(
  tx: Tx,
  row: AgentRow,
  input: Pick<SeeInput, "tenantId" | "sees">,
  /** The version's bundle to read the starts from (a sandbox run's); default the latest. */
  bundle?: AgentBundle,
): Promise<TryCandidate[]> {
  const v = bundle ? { bundle } : await versionToTry(tx, row);
  const starts = v ? documentStarts(v.bundle as AgentBundle) : [];
  if (starts.length === 0) return [];
  const docs = await tx
    .select()
    .from(document)
    .where(and(eq(document.tenantId, input.tenantId), ne(document.status, "failed")))
    .orderBy(desc(document.receivedAt), desc(document.id))
    .limit(CANDIDATES_SCANNED);
  const out: TryCandidate[] = [];
  for (const doc of docs) {
    if (out.length >= CANDIDATES_MAX) break;
    if (duplicateOfMeta(doc.meta)) continue;
    const found = await startFor(tx, doc, starts);
    if (!found) continue;
    if (!(await sees(tx, input, doc.id))) continue;
    out.push({
      documentId: doc.id,
      title: titleOf(doc, found.reading),
      from: fromOf(doc),
      at: doc.receivedAt.toISOString(),
    });
  }
  return out;
}

// ── Starting a try ───────────────────────────────────────────────────────────────────────────

const OPEN_RUN = ["queued", "running"] as const;

async function runsOf(tx: Tx, tenantId: string, ids: readonly string[]) {
  if (ids.length === 0) return [];
  return tx
    .select()
    .from(run)
    .where(and(eq(run.tenantId, tenantId), inArray(run.id, [...ids]), eq(run.mode, "test")));
}

/**
 * Starts a try: a test run of the agent's latest version on one of the client's documents, its
 * row written in the caller's transaction and recorded in `stage_state.guide.tries`. The caller
 * starts the run's instance after the commit (`request`).
 */
export async function startTry(
  tx: Tx,
  input: SeeInput & { documentId: string; ctx: RegistryContext },
): Promise<{ view: TryView; runId: string; request: RunRequest }> {
  if (!input.canSign) {
    throw new HttpError(403, "cannot_sign", "Only someone who can sign may try an agent.");
  }
  const row = await seeAgent(tx, input.tenantId, input.agentId, true);
  if (!beingSetUp(row)) {
    throw new HttpError(409, "not_in_setup", "Tries are for an agent being set up.");
  }
  const guide = guideOf(row);
  const tries = guide.tries ?? [];
  if (tries.length >= SETUP_TRIES_MAX) {
    throw new HttpError(
      409,
      "tries_used",
      `You've used the ${SETUP_TRIES_MAX} tries for this agent. Ask your lead if you'd like another.`,
    );
  }
  const open = (
    await runsOf(
      tx,
      input.tenantId,
      tries.map((t) => t.runId),
    )
  ).filter((r) => (OPEN_RUN as readonly string[]).includes(r.status));
  if (open.length > 0) {
    throw new HttpError(409, "try_running", "A try is running. Wait for it to finish.");
  }
  // Another client's document is not found here, as anywhere (RLS and the filter, invariant 1).
  const [doc] = await tx
    .select()
    .from(document)
    .where(and(eq(document.id, input.documentId), eq(document.tenantId, input.tenantId)));
  if (!doc || !(await sees(tx, input, doc.id))) throw notFound("document");

  const v = await versionToTry(tx, row);
  if (!v) throw new HttpError(409, "not_ready", "This agent isn't ready to try yet.");
  const bundle = v.bundle as AgentBundle;
  const found = await startFor(tx, doc, documentStarts(bundle));
  if (!found) {
    throw new HttpError(422, "cannot_try", "This agent doesn't start on that document.");
  }
  // Only a valid version is test-run (ARCHITECTURE §10.2), checked as the back office's Test run
  // checks it: with the client's bound connections.
  const errors = await validateForPublish(tx, row, bundle, input.ctx, {
    previous: await existingBundle(tx, v),
  });
  if (errors.length > 0) {
    throw new HttpError(
      409,
      "not_ready",
      "This agent isn't ready to try yet. Your lead can say why.",
    );
  }
  // A run sees only its client's rows: the shared skills it uses are copied in first, as the
  // back office's Test run does.
  await snapshotSharedSkills(tx, { tenantId: input.tenantId, bundle, catalog: input.ctx.catalog });
  let request: RunRequest;
  try {
    request = requestRun({
      agent: {
        id: row.id,
        tenantId: row.tenantId,
        kind: row.kind,
        status: row.status,
        runStatus: row.runStatus,
        liveVersionId: row.liveVersionId,
        liveBundle: null,
      },
      workflowSlug: found.start.slug,
      payload: found.payload,
      // Invariant 8: a try is a test run. It writes nothing and tells nobody.
      mode: "test",
      versionId: v.id,
      bundle,
    });
  } catch (error) {
    throw new HttpError(409, "cannot_try", error instanceof Error ? error.message : String(error));
  }
  await createRunRow(tx, request);
  const stored: StoredTry = {
    runId: request.runId,
    documentId: doc.id,
    title: titleOf(doc, found.reading),
    by: input.userId,
    byName: input.name,
    at: new Date().toISOString(),
  };
  await writeGuide(tx, row, { ...guide, tries: [...tries, stored] });
  const [r] = await runsOf(tx, input.tenantId, [request.runId]);
  return { view: await viewOf(tx, row, stored, r ?? null), runId: request.runId, request };
}

// ── Reading a try ────────────────────────────────────────────────────────────────────────────

/** Names for who a step would have asked: the run's seats, the client's people, the lead. */
async function namer(tx: Tx, tenantId: string, r: RunRow) {
  const members = await tx
    .select({
      userId: membership.userId,
      role: membership.role,
      name: appUser.name,
      email: appUser.email,
    })
    .from(membership)
    .innerJoin(appUser, eq(appUser.id, membership.userId))
    .where(eq(membership.tenantId, tenantId));
  const byUser = new Map(members.map((m) => [m.userId, m]));
  const config = (r.config ?? {}) as { people?: unknown; approver?: unknown };
  const seats = processes.seatsFromBindings(
    PeopleBindings.safeParse(config.people ?? {}).data ?? {},
  );
  const lead = await leadOf(tx, tenantId);
  const name = (who: string): string => {
    const role = processes.seatRoleOf(who);
    if (role !== null) {
      const ids = seats[role]?.userIds ?? [];
      return ids.length ? ids.map(name).join(" or ") : name("client_admin");
    }
    if (who === "client_admin") return "your admin";
    if (who === "client_user") return "your team";
    if (who === LEAD_ASSIGNEE || who === "lead") return lead ? leadDisplayName(lead) : "your lead";
    if (who === "operator") return "us";
    const m = byUser.get(who);
    if (m) return m.role === "operator" ? "us" : m.name?.trim() || m.email;
    return isUuid(who) ? "someone no longer on your team" : "your team";
  };
  const approver = typeof config.approver === "string" ? config.approver : null;
  return { name, approver };
}

/** Who a step would ask: a person step's assignee, or a write's approvers. */
function askedOf(step: TimelineStepDef, defaultApprover: string | null): string[] | null {
  const s = step as Record<string, unknown> & { kind: string };
  if (s.kind === "person" && typeof s.assignee === "string") return [s.assignee];
  if (s.kind === "write" || s.kind === "action") {
    const checks = s.checks as { approval?: { approvers?: { who?: string }[] } } | undefined;
    const named = (checks?.approval?.approvers ?? [])
      .map((a) => a.who)
      .filter((w): w is string => typeof w === "string");
    if (named.length) return named;
    // DECISION: a write without approvers of its own asks the agent's approver, else the client
    // admin; while an agent is being set up every write is signed, so a try always names someone.
    // Approver rules by amount are the SOP's to spell out; the try names the default.
    return [defaultApprover && defaultApprover !== "operator" ? defaultApprover : "client_admin"];
  }
  return null;
}

const STEP_STATE: Record<string, TryStep["state"]> = {
  pending: "running",
  running: "running",
  waiting: "waiting",
  succeeded: "done",
  failed: "failed",
  skipped: "skipped",
  cancelled: "skipped",
};

/**
 * The try as the client reads it: each step the timeline shows, in the order it ran, with its
 * state and its line (a write's reads "Would …", from the executor), and for a person step or a
 * write who would have been asked.
 */
// DECISION: a try's run that waits on a person has gone as far as a try goes (its item is ours, so
// nobody of the client's is asked), so it reads as done with that step waiting; only a run that
// is queued or running is running, and only that holds the next try.
async function viewOf(tx: Tx, row: AgentRow, t: StoredTry, r: RunRow | null): Promise<TryView> {
  if (!r || r.agentId !== row.id) throw notFound("try");
  const steps: TryStep[] = (await runStepsOf(tx, r)).map((s) => {
    const verdict = t.verdicts?.[s.id];
    return { ...s, verdict: verdict ? (verdict.right ? "right" : "not_right") : null };
  });
  return {
    runId: r.id,
    title: t.title,
    status: testRunStatus(r),
    startedAt: (r.startedAt ?? r.createdAt).toISOString(),
    steps,
  };
}

/** A test run's status as a try or a sandbox run reads it. */
export function testRunStatus(r: Pick<RunRow, "status">): TryView["status"] {
  return r.status === "queued" || r.status === "running"
    ? "running"
    : r.status === "failed" || r.status === "cancelled"
      ? "failed"
      : "done";
}

/**
 * A test run's steps as the client reads them (a try, or a sandbox run, docs/plan.md §1.243): each
 * step the timeline shows, in the order it ran, in the timeline's words.
 */
export async function runStepsOf(
  tx: Tx,
  r: RunRow,
  what = "a try",
): Promise<Omit<TryStep, "verdict">[]> {
  const [v] = await tx
    .select({ bundle: agentVersion.bundle })
    .from(agentVersion)
    .where(and(eq(agentVersion.id, r.agentVersionId), eq(agentVersion.tenantId, r.tenantId)));
  const wf = (v?.bundle as AgentBundle | undefined)?.workflows.find(
    (w) => w.slug === r.workflowSlug,
  );
  const find = stepFinder(wf?.workflow as Parameters<typeof stepFinder>[0]);
  // Only what the timeline reads: never cost, tokens, inputs or outputs (invariant 11).
  const rows = await tx
    .select({
      nodeId: stepRun.nodeId,
      nodeType: stepRun.nodeType,
      status: stepRun.status,
      summary: stepRun.summary,
    })
    .from(stepRun)
    .where(and(eq(stepRun.runId, r.id), eq(stepRun.tenantId, r.tenantId)))
    .orderBy(stepRun.startedAt, stepRun.id);
  const names = await namer(tx, r.tenantId, r);
  const steps: Omit<TryStep, "verdict">[] = [];
  for (const s of rows) {
    if (s.nodeType === "trigger" || checkKindOf(s.nodeId)) continue;
    const step = stepOfRow(find, s.nodeId);
    if (!step || !shownOnTimeline(step)) continue;
    const labelled = step as Step;
    const writes = step.kind === "write" || step.kind === "action";
    const state = STEP_STATE[s.status] ?? "running";
    const asked = askedOf(step, names.approver);
    const who = asked ? [...new Set(asked.map(names.name))].join(" and ") : null;
    let summary = summaryAfterLabel(s.summary, [clientLabel(labelled), step.name]);
    if (step.kind === "person" && who) {
      summary =
        state === "waiting" || state === "running"
          ? `Would ask ${who}. Nobody was asked: this is ${what}.`
          : `Would ask ${who}.`;
    } else if (writes && who && state === "done") {
      const line = (summary ?? `Would ${step.name}`).replace(/[.\s]*$/, ".");
      summary = `${line} Would ask ${who} first.`;
    }
    steps.push({
      id: s.nodeId,
      // A write in a try was never made: its own name ("Create bill"), not the done label.
      name: writes ? step.name : stepStateLabel(labelled, s.status === "succeeded"),
      state,
      summary,
      person: asked !== null,
    });
  }
  return steps;
}

/** Every try recorded for the agent, newest first, each as the client reads it. */
export async function tryViews(tx: Tx, row: AgentRow): Promise<TryView[]> {
  const tries = triesOf(guideOf(row));
  const runs = new Map(
    (
      await runsOf(
        tx,
        row.tenantId as string,
        tries.map((t) => t.runId),
      )
    ).map((r) => [r.id, r]),
  );
  const out: TryView[] = [];
  for (const t of tries) {
    const r = runs.get(t.runId);
    if (r) out.push(await viewOf(tx, row, t, r));
  }
  return out;
}

/** Whether a try of the agent is queued or running (the next waits for it). */
export async function tryRunning(tx: Tx, row: AgentRow): Promise<boolean> {
  const tries = guideOf(row).tries ?? [];
  const runs = await runsOf(
    tx,
    row.tenantId as string,
    tries.map((t) => t.runId),
  );
  return runs.some((r) => (OPEN_RUN as readonly string[]).includes(r.status));
}

async function recordedTry(tx: Tx, input: SeeInput & { runId: string }, lock = false) {
  const row = await seeAgent(tx, input.tenantId, input.agentId, lock);
  const guide = guideOf(row);
  // Only a try recorded on this agent: the portal hides test runs everywhere else.
  const t = (guide.tries ?? []).find((x) => x.runId === input.runId);
  if (!t) throw notFound("try");
  const [r] = await runsOf(tx, input.tenantId, [t.runId]);
  return { row, guide, t, r: r ?? null };
}

export async function tryView(tx: Tx, input: SeeInput & { runId: string }): Promise<TryView> {
  const { row, t, r } = await recordedTry(tx, input);
  return viewOf(tx, row, t, r);
}

/**
 * "Right" or "Not right because…" on one step of a try. Not right files a request to us with the
 * run as its source and the step it is about.
 */
// DECISION: the request is filed with `createIssue`, the function the manual's "This is wrong
// because…" files through, since only it takes the run (`originRunId`); its `about` names the try's
// run and step. A later verdict on the same step replaces the earlier one; a request filed stays.
export async function tryVerdict(
  tx: Tx,
  input: SeeInput & { runId: string; stepId: string; body: TryVerdictBody },
): Promise<TryView> {
  refuseViewer(input);
  const { row, guide, t, r } = await recordedTry(tx, input, true);
  const view = await viewOf(tx, row, t, r);
  const step = view.steps.find((s) => s.id === input.stepId);
  if (!step) throw notFound("step");
  const at = new Date().toISOString();
  let requestId: string | undefined;
  if (!input.body.right) {
    const agentName = row.serviceName ?? row.name;
    const text = [
      `On a try of ${agentName} on ${t.title}, step "${step.name}": not right.`,
      "",
      `Because: ${input.body.because}`,
    ].join("\n");
    const clipped = step.name.length > 60 ? `${step.name.slice(0, 59).trimEnd()}…` : step.name;
    const issue = await createIssue(tx, {
      tenantId: input.tenantId,
      title: `Not right on a try: ${clipped}`,
      description: text,
      agentId: row.id,
      source: "portal",
      raisedBy: input.userId,
      actor: "client",
      userId: input.userId,
      openingText: text,
      originRunId: t.runId,
      about: {
        kind: "setup_try",
        agentId: row.id,
        runId: t.runId,
        versionId: r?.agentVersionId ?? null,
        stepId: input.stepId,
        line: step.name.slice(0, 1000),
      },
    });
    requestId = issue.id;
  }
  const tries = (guide.tries ?? []).map((x) =>
    x.runId === t.runId
      ? {
          ...x,
          verdicts: {
            ...(x.verdicts ?? {}),
            [input.stepId]: {
              right: input.body.right,
              by: input.userId,
              byName: input.name,
              at,
              ...(requestId ? { requestId } : {}),
            },
          },
        }
      : x,
  );
  await writeGuide(tx, row, { ...guide, tries });
  const updated = tries.find((x) => x.runId === t.runId) as StoredTry;
  return viewOf(tx, row, updated, r);
}
