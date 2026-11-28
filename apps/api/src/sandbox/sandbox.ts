// A client's sandbox (docs/plan.md §1.243). Owner, 2026-11-24: "a sandbox for a client where we can
// run an agent like we do in the try it mode… it can read information, but not write it… as the
// output would show you what it would write… and allow them to push a send button so they can see
// it, for example a text message or an email."
//
// A sandbox run is a test run (invariant 8): it reads the client's data, records each write it
// would make as a proposed `external_action` and makes none, sends no notice and asks nobody. Its
// trigger carries `sandbox` (who started it, from which side), so both sides list it. It is
// started from the portal (a client person who can sign) or from the back office (a test run
// marked sandbox). Its view reads those recorded writes back as the client would see them: a
// record's fields before and after, an email or a text as it would arrive.
//
// "Send to me" sends one of its messages to the person asking, and nobody else: an email from the
// mailbox the agent would have used to their sign-in address; a text from the client's own Twilio
// number to the phone on their own entry in the client's directory, with texts allowed (as release
// codes find it). The address is ours, never the model's or the request's. It is the person's own
// action, as "Send a test email" is (plan §1.31): not a run's write, so it goes through no approval;
// it is recorded in the connection's history and the audit log, and counted as the client's usage.
// DECISION: the operator sends only in the Sandbox client; in a real client only the client's own
// people send from the client's tools (we never act in a client's tools on our own, invariant 8).
// DECISION: texts only from the client's own number: until it can text (connected, an SMS number,
// A2P approved) a text can be read but not sent (owner, 2026-11-24).
// DECISION: limits, counted over the last 24 hours across both sides: 20 sandbox runs and 20 sends
// a client; one open sandbox run per agent; one send a minute per person. Sandbox runs are test
// runs of the client's agent, so their model use is the client's (as tries are).

import {
  checkAgainst,
  existingBundle,
  getVersion,
  latestVersion,
  type RegistryContext,
  snapshotSharedSkills,
  validateForPublish,
} from "@countersign/agents";
import {
  GmailNoAddressError,
  MimeError,
  noopLogger,
  ReconnectRequiredError,
} from "@countersign/connectors";
import {
  type AgentBundle,
  isPlainObject,
  SANDBOX_RUNS_PER_DAY,
  SANDBOX_SEND_CHANGE,
  SANDBOX_SENDS_PER_DAY,
  type SandboxChange,
  type SandboxChannel,
  type SandboxField,
  SandboxMark,
  type SandboxMessage,
  type SandboxNotice,
  type SandboxRun,
  type SandboxRunSummary,
  type SandboxSend,
  type SandboxSent,
  type SandboxSide,
  type SandboxStartBody,
  type SandboxUse,
  type SandboxView,
  uuidv7,
} from "@countersign/core";
import {
  agent,
  agentVersion,
  appUser,
  connection,
  connectionChange,
  document,
  externalAction,
  run,
  stepRun,
  type Tx,
  tenant,
} from "@countersign/db";
import { type RunRequest, requestRun } from "@countersign/workflows";
import { and, count, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { textableContact } from "../access/release";
import type { Bindings } from "../env";
import { HttpError, notFound } from "../http";
import { clientRunnable } from "../lifecycle/runs";
import { meter } from "../metering";
import type { Texter } from "../notify/mailer";
import { reportHandled } from "../observability/report";
import type { Platform } from "../platform";
import { stepFinder, stepOfRow } from "../routes/run-checks";
import { createRunRow } from "../runs/dispatch";
import { connectionCredentials } from "../secrets";
import {
  documentStarts,
  runStepsOf,
  sees,
  startFor,
  testRunStatus,
  titleOf,
  tryCandidates,
} from "../setup/try";
import { refOf } from "../zoho/sync";

type RunRow = typeof run.$inferSelect;
type AgentRow = typeof agent.$inferSelect;

/** A run marked sandbox (`run.trigger.sandbox`). */
const IS_SANDBOX = sql`${run.trigger}->'sandbox' is not null`;
const LAST_DAY = sql`now() - interval '1 day'`;

export function sandboxMarkOf(trigger: unknown): SandboxMark | null {
  const m = SandboxMark.safeParse(isPlainObject(trigger) ? trigger.sandbox : undefined);
  return m.success ? m.data : null;
}

/** The run request as a sandbox run: its trigger carries who started it and where. */
export function markSandbox<T extends RunRequest>(req: T, mark: SandboxMark): T {
  return { ...req, trigger: { ...req.trigger, sandbox: mark } } as T;
}

// ── Use and limits ───────────────────────────────────────────────────────────────────────────

export async function sandboxUse(tx: Tx, tenantId: string): Promise<SandboxUse> {
  const [runs] = await tx
    .select({ n: count() })
    .from(run)
    .where(
      and(
        eq(run.tenantId, tenantId),
        eq(run.mode, "test"),
        IS_SANDBOX,
        gt(run.createdAt, LAST_DAY),
      ),
    );
  const [sends] = await tx
    .select({ n: count() })
    .from(connectionChange)
    .where(
      and(
        eq(connectionChange.tenantId, tenantId),
        sql`${connectionChange.change}->>'kind' = ${SANDBOX_SEND_CHANGE}`,
        gt(connectionChange.createdAt, LAST_DAY),
      ),
    );
  return {
    runs: runs?.n ?? 0,
    maxRuns: SANDBOX_RUNS_PER_DAY,
    sends: sends?.n ?? 0,
    maxSends: SANDBOX_SENDS_PER_DAY,
  };
}

/** Refuses a sandbox run past the day's limit, or while one of the same agent is open. */
export async function ensureSandboxRoom(tx: Tx, tenantId: string, agentId: string): Promise<void> {
  const use = await sandboxUse(tx, tenantId);
  if (use.runs >= use.maxRuns) {
    throw new HttpError(
      429,
      "sandbox_limit",
      `You've used today's ${use.maxRuns} sandbox runs. Try again tomorrow.`,
    );
  }
  const [open] = await tx
    .select({ id: run.id })
    .from(run)
    .where(
      and(
        eq(run.tenantId, tenantId),
        eq(run.agentId, agentId),
        eq(run.mode, "test"),
        IS_SANDBOX,
        inArray(run.status, ["queued", "running"]),
      ),
    )
    .limit(1);
  if (open) {
    throw new HttpError(
      409,
      "sandbox_running",
      "This agent is running in the sandbox. Wait for it to finish.",
    );
  }
}

// ── Starting from the portal ─────────────────────────────────────────────────────────────────

/** The client's own agents a sandbox runs: active, not a test copy, not retired. */
async function clientAgents(tx: Tx, tenantId: string, sees: readonly string[] | null) {
  const rows = await tx
    .select()
    .from(agent)
    .where(
      and(
        eq(agent.tenantId, tenantId),
        eq(agent.kind, "client"),
        eq(agent.status, "active"),
        eq(agent.testCopy, false),
      ),
    )
    .orderBy(agent.name);
  return rows.filter((r) => r.runStatus !== "retired" && (sees === null || sees.includes(r.id)));
}

async function oneAgent(tx: Tx, tenantId: string, agentId: string, lock = false) {
  const q = tx
    .select()
    .from(agent)
    .where(and(eq(agent.id, agentId), eq(agent.tenantId, tenantId), eq(agent.kind, "client")));
  const [row] = lock ? await q.for("update") : await q;
  if (!row || row.testCopy || row.status !== "active" || row.runStatus === "retired") {
    throw notFound("agent");
  }
  return row;
}

/**
 * The version a sandbox run of the agent runs: its live one, else (being set up) its latest.
 */
// DECISION: the portal runs what the client would get: the live version once there is one, so a
// draft of ours in progress is never put before the client. The back office chooses the version.
export async function sandboxVersion(tx: Tx, row: AgentRow) {
  if (row.liveVersionId) {
    const v = await getVersion(tx, row.liveVersionId);
    return v.tenantId === row.tenantId ? v : null;
  }
  const v = await latestVersion(tx, row.id);
  return v && v.tenantId === row.tenantId ? v : null;
}

const nameOfAgent = (a: Pick<AgentRow, "name" | "serviceName">) => a.serviceName ?? a.name;

export interface PortalPerson {
  tenantId: string;
  userId: string;
  name: string | null;
  canSign: boolean;
  sees: readonly string[] | null;
}

/** The portal's sandbox: the agents this person may try, what each starts from, recent runs. */
export async function portalSandbox(
  tx: Tx,
  input: PortalPerson & { platform?: Pick<Platform, "tools"> },
): Promise<SandboxView> {
  const agents: SandboxView["agents"] = [];
  for (const row of await clientAgents(tx, input.tenantId, input.sees)) {
    const v = await sandboxVersion(tx, row);
    if (!v) continue;
    const bundle = v.bundle as AgentBundle;
    const documents = await tryCandidates(tx, row, input, bundle);
    const forms = clientRunnable(bundle);
    // An agent with nothing a person can start it on (a schedule only) is the back office's to try.
    if (documents.length === 0 && forms.length === 0 && documentStarts(bundle).length === 0) {
      continue;
    }
    agents.push({
      id: row.id,
      name: nameOfAgent(row),
      documents,
      forms,
      running: await sandboxOpen(tx, input.tenantId, row.id),
    });
  }
  return {
    agents,
    runs: await sandboxRuns(tx, {
      tenantId: input.tenantId,
      sees: input.sees,
      side: "portal",
      ...(input.platform ? { platform: input.platform } : {}),
    }),
    use: await sandboxUse(tx, input.tenantId),
    canTry: input.canSign,
  };
}

async function sandboxOpen(tx: Tx, tenantId: string, agentId: string) {
  const [open] = await tx
    .select({ id: run.id })
    .from(run)
    .where(
      and(
        eq(run.tenantId, tenantId),
        eq(run.agentId, agentId),
        eq(run.mode, "test"),
        IS_SANDBOX,
        inArray(run.status, ["queued", "running"]),
      ),
    )
    .limit(1);
  return Boolean(open);
}

/**
 * Starts a sandbox run from the portal: on one of the client's documents (as the router would on
 * that document), or a hand-started workflow with its form, checked against its schema. The row is
 * written in the caller's transaction; the caller starts the instance after the commit.
 */
export async function startPortalSandboxRun(
  tx: Tx,
  input: PortalPerson & { body: SandboxStartBody; ctx: RegistryContext },
): Promise<RunRequest> {
  if (!input.canSign) {
    throw new HttpError(
      403,
      "cannot_sign",
      "Only someone who can sign may run an agent in the sandbox.",
    );
  }
  const { body } = input;
  if (input.sees !== null && !input.sees.includes(body.agentId)) throw notFound("agent");
  // Locked, so two starts at once can't both pass the one-open-run check.
  const row = await oneAgent(tx, input.tenantId, body.agentId, true);
  await ensureSandboxRoom(tx, input.tenantId, row.id);
  const v = await sandboxVersion(tx, row);
  if (!v) throw new HttpError(409, "not_ready", "This agent isn't ready to try yet.");
  const bundle = v.bundle as AgentBundle;

  let slug: string;
  let payload: unknown;
  let title: string;
  if ("documentId" in body) {
    // Another client's document is not found here, as anywhere (RLS and the filter, invariant 1).
    const [doc] = await tx
      .select()
      .from(document)
      .where(and(eq(document.id, body.documentId), eq(document.tenantId, input.tenantId)));
    if (!doc || !(await sees(tx, input, doc.id))) throw notFound("document");
    const found = await startFor(tx, doc, documentStarts(bundle));
    if (!found)
      throw new HttpError(422, "cannot_try", "This agent doesn't start on that document.");
    slug = found.start.slug;
    payload = found.payload;
    title = titleOf(doc, found.reading);
  } else {
    const form = clientRunnable(bundle).find((f) => f.workflow === body.workflow);
    if (!form) throw notFound("workflow");
    // The same JSON Schema reader Run now checks its form with (invariant 5).
    const checked = checkAgainst(form.input, body.input ?? {});
    if (!checked.ok) throw new HttpError(422, "invalid_input", checked.message);
    slug = form.workflow;
    payload = checked.value;
    title = form.label;
  }
  // Only a valid version runs, checked as the back office's Test run checks it.
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
      workflowSlug: slug,
      payload,
      // Invariant 8: a sandbox run is a test run. It writes nothing and tells nobody.
      mode: "test",
      versionId: v.id,
      bundle,
    });
  } catch (error) {
    throw new HttpError(409, "cannot_try", error instanceof Error ? error.message : String(error));
  }
  const marked = markSandbox(request, {
    by: input.userId,
    side: "portal",
    title: title.slice(0, 300),
  });
  await createRunRow(tx, marked);
  return marked;
}

// ── Reading sandbox runs ─────────────────────────────────────────────────────────────────────

/** Who asked, as the side reading it says: on the portal, a run of ours reads "Mezonas". */
function byNameOf(
  mark: SandboxMark,
  names: Map<string, string>,
  reader: SandboxSide,
): string | null {
  if (reader === "portal" && mark.side === "ops") return "Mezonas";
  return names.get(mark.by) ?? null;
}

async function userNames(tx: Tx, ids: Iterable<string>): Promise<Map<string, string>> {
  const list = [...new Set(ids)].filter(Boolean);
  if (list.length === 0) return new Map();
  const rows = await tx
    .select({ id: appUser.id, name: appUser.name, email: appUser.email })
    .from(appUser)
    .where(inArray(appUser.id, list));
  return new Map(rows.map((u) => [u.id, u.name?.trim() || u.email]));
}

/** Changes per run, and how many are messages (a write whose tool names a recipient). */
async function changeCounts(
  tx: Tx,
  tenantId: string,
  runIds: string[],
  platform: Pick<Platform, "tools"> | null,
) {
  const out = new Map<string, { changes: number; messages: number }>();
  if (runIds.length === 0) return out;
  const rows = await tx
    .select({ runId: externalAction.runId, tool: externalAction.tool })
    .from(externalAction)
    .where(and(eq(externalAction.tenantId, tenantId), inArray(externalAction.runId, runIds)));
  for (const r of rows) {
    if (!r.runId) continue;
    const c = out.get(r.runId) ?? { changes: 0, messages: 0 };
    c.changes += 1;
    if (platform?.tools.get(r.tool)?.spec.recipient) c.messages += 1;
    out.set(r.runId, c);
  }
  return out;
}

function summaryOf(
  r: RunRow,
  a: Pick<AgentRow, "name" | "serviceName">,
  mark: SandboxMark,
  names: Map<string, string>,
  reader: SandboxSide,
  counts: { changes: number; messages: number } | undefined,
): SandboxRunSummary {
  return {
    runId: r.id,
    agentId: r.agentId,
    agentName: nameOfAgent(a),
    title: mark.title ?? nameOfAgent(a),
    status: testRunStatus(r),
    startedAt: (r.startedAt ?? r.createdAt).toISOString(),
    side: mark.side,
    byName: byNameOf(mark, names, reader),
    changes: counts?.changes ?? 0,
    messages: counts?.messages ?? 0,
  };
}

/** The client's sandbox runs, newest first (at most 30), of the agents this person sees. */
export async function sandboxRuns(
  tx: Tx,
  input: {
    tenantId: string;
    sees: readonly string[] | null;
    side: SandboxSide;
    platform?: Pick<Platform, "tools">;
  },
): Promise<SandboxRunSummary[]> {
  if (input.sees !== null && input.sees.length === 0) return [];
  const rows = await tx
    .select({ r: run, name: agent.name, serviceName: agent.serviceName })
    .from(run)
    .innerJoin(agent, and(eq(agent.id, run.agentId), eq(agent.tenantId, run.tenantId)))
    .where(
      and(
        eq(run.tenantId, input.tenantId),
        eq(run.mode, "test"),
        IS_SANDBOX,
        eq(agent.testCopy, false),
        ...(input.sees === null ? [] : [inArray(run.agentId, [...input.sees])]),
      ),
    )
    .orderBy(desc(run.createdAt), desc(run.id))
    .limit(30);
  const marks = rows.map((x) => sandboxMarkOf(x.r.trigger));
  const names = await userNames(
    tx,
    marks.flatMap((m) => (m ? [m.by] : [])),
  );
  const counts = await changeCounts(
    tx,
    input.tenantId,
    rows.map((x) => x.r.id),
    input.platform ?? null,
  );
  const out: SandboxRunSummary[] = [];
  rows.forEach((x, i) => {
    const mark = marks[i];
    if (mark) out.push(summaryOf(x.r, x, mark, names, input.side, counts.get(x.r.id)));
  });
  return out;
}

/** Who is reading a sandbox run, and whether they may have its messages sent to them. */
export interface SandboxReader {
  tenantId: string;
  userId: string;
  /** Their sign-in email: where an email preview goes. */
  email: string;
  side: SandboxSide;
  sees: readonly string[] | null;
  /** Null when they may send; else why not, in plain words. */
  cannotSend: string | null;
}

export interface SandboxDeps {
  platform: Pick<Platform, "tools" | "connectors">;
  texter: Pick<Texter, "from" | "send">;
  env: Pick<Bindings, "ENCRYPTION_KEY" | "ENCRYPTION_KEY_PREVIOUS">;
}

async function sandboxRunRow(tx: Tx, reader: SandboxReader, runId: string) {
  const [x] = await tx
    .select({ r: run, a: agent })
    .from(run)
    .innerJoin(agent, and(eq(agent.id, run.agentId), eq(agent.tenantId, run.tenantId)))
    .where(and(eq(run.id, runId), eq(run.tenantId, reader.tenantId), eq(run.mode, "test")));
  const mark = x ? sandboxMarkOf(x.r.trigger) : null;
  // Only a sandbox run, of an agent this person sees: the portal hides every other test run.
  if (!x || !mark || x.a.testCopy) throw notFound("run");
  if (reader.sees !== null && !reader.sees.includes(x.r.agentId)) throw notFound("run");
  return { r: x.r, a: x.a, mark };
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** A field's value in words: a string as it is, anything else as JSON, kept short. */
function shown(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 300 ? `${s.slice(0, 299)}…` : s;
}

/** A record's fields: each the input sets, with what the before state had there. */
function fieldsOf(input: unknown, before: unknown): SandboxField[] {
  if (!isPlainObject(input)) return [];
  const was = isPlainObject(before) ? before : {};
  return Object.entries(input)
    .filter(([k]) => k !== "attachments")
    .map(([field, after]) => ({ field, before: shown(was[field]), after: shown(after) }));
}

const CHANNELS = new Set<SandboxChannel>(["email", "sms", "whatsapp", "voice"]);

/** A message write as it would arrive, from its input and the before state the tool recorded. */
function messageOf(channel: string, path: string, input: unknown, before: unknown): SandboxMessage {
  const i = isPlainObject(input) ? input : {};
  const b = isPlainObject(before) ? before : {};
  const contact = isPlainObject(b.contact) ? b.contact : {};
  const template = isPlainObject(i.template) ? i.template : null;
  const attachments = Array.isArray(i.attachments) ? i.attachments.length : 0;
  return {
    channel: CHANNELS.has(channel as SandboxChannel) ? (channel as SandboxChannel) : "other",
    to: text(i[path]) ?? text(b.to) ?? "",
    toName: text(contact.name),
    from: text(b.from),
    subject: text(i.subject) ?? text(b.subject),
    text:
      text(i.text) ??
      text(b.text) ??
      (template ? `A WhatsApp template message (${String(template.id)})` : null),
    attachments,
  };
}

const maskPhone = (phone: string) => `•••• ${phone.slice(-4)}`;

/** Where this person's previews go, worked out once per view. */
async function destinations(tx: Tx, reader: SandboxReader, deps: SandboxDeps) {
  const phone = (await textableContact(tx, reader.tenantId, reader.email))?.phone ?? null;
  const textFrom = await deps.texter.from(tx, reader.tenantId).catch(() => null);
  const use = await sandboxUse(tx, reader.tenantId);
  return { phone, textFrom, use };
}

type Destinations = Awaited<ReturnType<typeof destinations>>;

function sendOf(
  message: SandboxMessage,
  conn: { connector: string; status: string },
  reader: SandboxReader,
  deps: SandboxDeps,
  where: Destinations,
): SandboxSend | null {
  let send: SandboxSend;
  if (message.channel === "email") {
    const can = Boolean(deps.platform.connectors.get(conn.connector)?.sendPreview);
    send = {
      channel: "email",
      to: reader.email,
      can,
      reason: can ? null : "We can't send a preview from this tool yet.",
    };
    if (can && conn.status !== "connected") {
      send = { ...send, can: false, reason: "This tool isn't connected right now." };
    }
  } else if (message.channel === "sms" || message.channel === "whatsapp") {
    if (!where.textFrom) {
      send = {
        channel: "sms",
        to: where.phone ? maskPhone(where.phone) : null,
        can: false,
        reason: "Your texting number isn't set up yet, so texts can be read here but not sent.",
      };
    } else if (!where.phone) {
      send = {
        channel: "sms",
        to: null,
        can: false,
        reason: "Add your mobile number to your own contact, with texts allowed, to get texts.",
      };
    } else {
      send = { channel: "sms", to: maskPhone(where.phone), can: true, reason: null };
    }
  } else {
    return null;
  }
  if (send.can && reader.cannotSend) return { ...send, can: false, reason: reader.cannotSend };
  if (send.can && where.use.sends >= where.use.maxSends) {
    return { ...send, can: false, reason: `You've used today's ${where.use.maxSends} previews.` };
  }
  return send;
}

/** Every change the run would have made, as the client reads it. */
async function changesOf(
  tx: Tx,
  reader: SandboxReader,
  deps: SandboxDeps,
  r: RunRow,
  find: ReturnType<typeof stepFinder>,
): Promise<SandboxChange[]> {
  const rows = await tx
    .select({
      a: externalAction,
      connector: connection.connector,
      status: connection.status,
      nodeId: stepRun.nodeId,
    })
    .from(externalAction)
    .innerJoin(
      connection,
      and(
        eq(connection.id, externalAction.connectionId),
        eq(connection.tenantId, externalAction.tenantId),
      ),
    )
    .leftJoin(
      stepRun,
      and(eq(stepRun.id, externalAction.stepRunId), eq(stepRun.tenantId, externalAction.tenantId)),
    )
    .where(and(eq(externalAction.tenantId, r.tenantId), eq(externalAction.runId, r.id)))
    .orderBy(externalAction.createdAt, externalAction.id);
  if (rows.length === 0) return [];
  const where = await destinations(tx, reader, deps);
  const sentRows = await tx
    .select({
      change: connectionChange.change,
      at: connectionChange.createdAt,
      actorId: connectionChange.actorId,
    })
    .from(connectionChange)
    .where(
      and(
        eq(connectionChange.tenantId, r.tenantId),
        sql`${connectionChange.change}->>'kind' = ${SANDBOX_SEND_CHANGE}`,
        sql`${connectionChange.change}->>'runId' = ${r.id}`,
      ),
    )
    .orderBy(connectionChange.createdAt);
  const names = await userNames(
    tx,
    sentRows.flatMap((s) => (s.actorId ? [s.actorId] : [])),
  );
  const out: SandboxChange[] = [];
  for (const row of rows) {
    const a = row.a;
    const tool = deps.platform.tools.get(a.tool);
    const connectorName =
      deps.platform.connectors.get(row.connector)?.manifest.name ?? row.connector;
    const step = row.nodeId ? stepOfRow(find, row.nodeId) : undefined;
    const recipient = tool?.spec.recipient;
    const message = recipient
      ? messageOf(recipient.channel, recipient.path, a.input, a.before)
      : null;
    const sent: SandboxSent[] = sentRows
      .filter((s) => isPlainObject(s.change) && s.change.actionId === a.id)
      .map((s) => {
        const c = s.change as Record<string, unknown>;
        const channel = c.channel === "sms" ? "sms" : "email";
        const to = typeof c.to === "string" ? c.to : "";
        return {
          at: s.at.toISOString(),
          byName: s.actorId ? (names.get(s.actorId) ?? null) : null,
          channel,
          to: channel === "sms" ? maskPhone(to) : to,
        };
      });
    const who = message ? (message.toName ?? message.to) : null;
    const title = message
      ? `${message.channel === "email" ? "Email" : message.channel === "voice" ? "Call" : "Text"} to ${who || "a contact"}`
      : (step?.name ?? a.tool);
    out.push({
      id: a.id,
      stepId: row.nodeId ?? null,
      stepName: step?.name ?? null,
      kind: message ? "message" : "record",
      title: title.slice(0, 200),
      tool: { connector: row.connector, connectorName },
      message,
      fields: message ? [] : fieldsOf(a.input, a.before),
      send: message ? sendOf(message, row, reader, deps, where) : null,
      sent,
    });
  }
  return out;
}

/** The notices the run would have sent (notify steps): their text stays on the step. */
async function noticesOf(
  tx: Tx,
  r: RunRow,
  find: ReturnType<typeof stepFinder>,
): Promise<SandboxNotice[]> {
  const rows = await tx
    .select({ nodeId: stepRun.nodeId, input: stepRun.input })
    .from(stepRun)
    .where(
      and(
        eq(stepRun.tenantId, r.tenantId),
        eq(stepRun.runId, r.id),
        eq(stepRun.nodeType, "notify"),
      ),
    )
    .orderBy(stepRun.startedAt, stepRun.id);
  const out: SandboxNotice[] = [];
  for (const s of rows) {
    const i = isPlainObject(s.input) ? s.input : {};
    const body = text(i.text);
    if (!body) continue;
    out.push({
      stepId: s.nodeId,
      stepName: stepOfRow(find, s.nodeId)?.name ?? null,
      channel: text(i.channel) ?? "notice",
      to: text(i.to),
      text: body,
    });
  }
  return out;
}

/** One sandbox run in full: its steps, what it would have changed, and its notices. */
export async function sandboxRunView(
  tx: Tx,
  reader: SandboxReader,
  deps: SandboxDeps,
  runId: string,
): Promise<SandboxRun> {
  const { r, a, mark } = await sandboxRunRow(tx, reader, runId);
  const [v] = await tx
    .select({ bundle: agentVersion.bundle })
    .from(agentVersion)
    .where(and(eq(agentVersion.id, r.agentVersionId), eq(agentVersion.tenantId, r.tenantId)));
  const wf = (v?.bundle as AgentBundle | undefined)?.workflows.find(
    (w) => w.slug === r.workflowSlug,
  );
  const find = stepFinder(wf?.workflow as Parameters<typeof stepFinder>[0]);
  const names = await userNames(tx, [mark.by]);
  const changes = await changesOf(tx, reader, deps, r, find);
  const { changes: _count, ...summary } = summaryOf(r, a, mark, names, reader.side, {
    changes: changes.length,
    messages: changes.filter((c) => c.kind === "message").length,
  });
  return {
    ...summary,
    changeCount: changes.length,
    steps: await runStepsOf(tx, r, "a sandbox run"),
    changes,
    notices: await noticesOf(tx, r, find),
  };
}

// ── Send to me ───────────────────────────────────────────────────────────────────────────────

function emailBody(m: SandboxMessage): string {
  const lines = [
    "This is a sandbox preview from Mezonas. Nothing was sent to anyone else.",
    "",
    `It would have gone to ${m.toName ? `${m.toName} <${m.to}>` : m.to}${m.from ? ` from ${m.from}` : ""}.`,
  ];
  if (m.attachments > 0) {
    lines.push(
      `It would have carried ${m.attachments} attachment${m.attachments === 1 ? "" : "s"}, not included here.`,
    );
  }
  lines.push("", "----------", "", m.text ?? "");
  return lines.join("\n");
}

function smsBody(m: SandboxMessage): string {
  const head = `Sandbox preview, would have gone to ${m.toName ?? m.to}: `;
  return `${head}${m.text ?? ""}`.slice(0, 1600);
}

/**
 * Sends one of a sandbox run's messages to the person asking, and records it. Refused (409
 * `cannot_send`, with why) when the view says they can't; at most one a minute per person.
 */
export async function sendToMe(
  tx: Tx,
  reader: SandboxReader,
  deps: SandboxDeps,
  input: { runId: string; changeId: string },
): Promise<SandboxRun> {
  const view = await sandboxRunView(tx, reader, deps, input.runId);
  const change = view.changes.find((c) => c.id === input.changeId);
  if (!change?.message) throw notFound("change");
  const send = change.send;
  if (!send?.can) {
    throw new HttpError(409, "cannot_send", send?.reason ?? "This change can't be sent to you.");
  }
  const [action] = await tx
    .select()
    .from(externalAction)
    .where(and(eq(externalAction.id, change.id), eq(externalAction.tenantId, reader.tenantId)));
  if (!action) throw notFound("change");
  // The connection is locked until the send is recorded, so two clicks at once send once.
  const [conn] = await tx
    .select()
    .from(connection)
    .where(and(eq(connection.id, action.connectionId), eq(connection.tenantId, reader.tenantId)))
    .for("update");
  if (!conn) throw notFound("connection");
  const [recent] = await tx
    .select({ n: count() })
    .from(connectionChange)
    .where(
      and(
        eq(connectionChange.tenantId, reader.tenantId),
        eq(connectionChange.actorId, reader.userId),
        sql`${connectionChange.change}->>'kind' = ${SANDBOX_SEND_CHANGE}`,
        gt(connectionChange.createdAt, sql`now() - interval '1 minute'`),
      ),
    );
  if ((recent?.n ?? 0) > 0) {
    throw new HttpError(
      429,
      "rate_limited",
      "We sent you a preview less than a minute ago. Wait a minute and try again.",
    );
  }
  const m = change.message;
  let to: string;
  let messageId: string;
  try {
    if (send.channel === "email") {
      const connector = deps.platform.connectors.get(conn.connector);
      if (!connector?.sendPreview) {
        throw new HttpError(409, "cannot_send", "We can't send a preview from this tool yet.");
      }
      if (!deps.env.ENCRYPTION_KEY) {
        throw new HttpError(503, "not_configured", "Sending is not set up here yet.");
      }
      const now = new Date();
      to = reader.email.toLowerCase();
      const sent = await connector.sendPreview(
        {
          tenantId: reader.tenantId,
          connection: refOf(conn),
          credentials: await connectionCredentials(tx, deps.env, conn),
          logger: noopLogger,
          now: () => now,
        },
        {
          to,
          subject: `[Sandbox] ${m.subject ?? `Message to ${m.toName ?? m.to}`}`.slice(0, 250),
          text: emailBody(m),
          key: uuidv7(),
        },
      );
      messageId = sent.id;
    } else {
      const phone = (await textableContact(tx, reader.tenantId, reader.email))?.phone;
      if (!phone) throw new HttpError(409, "cannot_send", "We don't have a mobile number for you.");
      to = phone;
      messageId = await deps.texter.send(tx, reader.tenantId, { to: phone, body: smsBody(m) });
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof GmailNoAddressError || error instanceof MimeError) {
      throw new HttpError(
        409,
        "no_address",
        "We don't know this mailbox's address. Connect it again.",
      );
    }
    if (error instanceof ReconnectRequiredError) {
      throw new HttpError(409, "not_connected", "This tool needs to be connected again.");
    }
    reportHandled("sandbox preview failed", error, { connector: conn.connector });
    throw new HttpError(
      502,
      "connector_failed",
      "The preview didn't go out. Try again in a moment.",
    );
  }
  await tx.insert(connectionChange).values({
    tenantId: reader.tenantId,
    connectionId: conn.id,
    actorId: reader.userId,
    change: {
      kind: SANDBOX_SEND_CHANGE,
      by: reader.side === "ops" ? "operator" : "client",
      runId: view.runId,
      actionId: change.id,
      channel: send.channel,
      to,
      messageId,
    },
  });
  // The client's own usage, as a release code's text or email is.
  await meter(tx, {
    tenantId: reader.tenantId,
    measure: send.channel === "email" ? "emails" : "messages",
    source: "sandbox_preview",
    key: `sandbox:${change.id}:${messageId}`,
    agentId: view.agentId,
    runId: view.runId,
  });
  return sandboxRunView(tx, reader, deps, input.runId);
}

/** Whether the client is our Sandbox client (`tenant.settings.sandbox`). */
export async function isSandboxClient(tx: Tx, tenantId: string): Promise<boolean> {
  const [t] = await tx
    .select({ settings: tenant.settings })
    .from(tenant)
    .where(and(eq(tenant.id, tenantId), isNull(tenant.retiredAt)));
  return (t?.settings as { sandbox?: unknown } | undefined)?.sandbox === true;
}
