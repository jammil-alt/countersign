// ElevenLabs during and after a call (docs/plan.md §1.23), public:
//
// - `POST /api/voice/:tenantId/tools/:tool`: the voice agent uses a tool. The call's id and its token
//   (an HMAC only that call has, sent as ElevenLabs' secret dynamic variable) are the credential.
//   The tool must be one of the call's step's tools and must only read; it then runs through the
//   permission gate (callTool) as the call's client agent version, with that agent's bindings and
//   the connection's matrix, like any step. `propose_follow_up` notes what the caller asked to
//   change; nothing is changed during a call (invariant 8), and agents can't change their own
//   permissions (invariant 9). Once the call is over its token stops working.
// - `POST /api/elevenlabs/post-call`: the call's transcript and summary, signed with Mezonas'
//   webhook secret, stored once per conversation as untrusted data (and only if the person agreed
//   to a record), a line in the contact's thread, each follow-up as a review item in the inbox,
//   and `call.completed`.

import {
  type Assignee,
  callTool,
  clientApproverSetting,
  createDbPorts,
  type RunLog,
  type RuntimeDeps,
  resolveApprover,
  type StepContext,
} from "@countersign/agents";
import {
  CALL_COMPLETED_EVENT,
  type CallCompletedPayload,
  credentialKeysFromEnv,
  ELEVENLABS_CONNECTOR_ID,
  FOLLOW_UP_TOOL,
  parsePostCall,
  TWILIO_CALL_TOOL_ENTITY,
  toolIdOfVoiceName,
  verifyElevenLabsSignature,
  verifyVoiceToolToken,
} from "@countersign/connectors";
import { routes } from "@countersign/core";
import { agent, agentVersion, inboxItem, tenant, withTenant } from "@countersign/db";
import { type EventRow, emit } from "@countersign/senses";
import { and, eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { coverOnlyReleasePort } from "../access/release";
import {
  CALL_ENTITIES,
  type CallPayload,
  type CallRequestPayload,
  callByCallId,
  findByPayload,
  findRecord,
  storeOnce,
  type TranscriptPayload,
  threadCallLine,
} from "../calls/store";
import { type AppEnv, errorResponse, HttpError } from "../http";
import { connectorServicesFor } from "../messaging/services";
import { dispatchEvents, senseEmitter } from "../runs/dispatch";
import { credentialsFor, workerTransport } from "../runs/execute";
import { voiceDepsFor } from "./twilio-voice";

const TOOL_BODY_MAX = 16 * 1024;
const POST_CALL_MAX = 2 * 1024 * 1024;
const ToolParams = z.object({
  tenantId: z.uuid(),
  tool: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
});
const FollowUp = z.object({ what: z.string().trim().min(1).max(1000) });
/** A call's token works until the call ends, and at most this long past its time limit. */
const GRACE_MS = 5 * 60 * 1000;

async function readText(req: Request, max: number): Promise<string> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > max) throw new HttpError(413, "too_large", "the body is too large");
  const text = await req.text();
  if (text.length > max) throw new HttpError(413, "too_large", "the body is too large");
  return text;
}

const unauthorized = () => new HttpError(401, "unauthorized", "unknown call or bad token");

/** What a call may do, from its records: the agent version, the tools, and whether it is over. */
interface CallScope {
  callId: string;
  connectionId: string;
  agentVersionId: string;
  runId: string | null;
  stepRunId: string | null;
  tools: string[];
  callSid: string | null;
}

/** tool_call rows need a step run; a call's tool use is kept as raw records on the call instead. */
function callToolLog(
  db: RuntimeDeps["ports"]["log"],
  scope: CallScope,
  store: (r: object) => Promise<void>,
): RunLog {
  const started = new Map<string, { tool: string; input: unknown }>();
  return {
    ...db,
    async startToolCall(_tenantId, input) {
      const id = crypto.randomUUID();
      started.set(id, { tool: input.tool, input: input.input });
      return id;
    },
    async finishToolCall(_tenantId, id, result) {
      const s = started.get(id);
      await store({
        callId: scope.callId,
        callSid: scope.callSid,
        tool: s?.tool ?? null,
        input: s?.input ?? null,
        status: result.status,
        output: result.output ?? null,
        durationMs: result.durationMs,
      });
    },
  };
}

export function voiceHookRoutes(app: Hono<AppEnv>): void {
  app.post(routes.voiceTool.path, async (c: Context<AppEnv>) => {
    try {
      const params = ToolParams.safeParse(c.req.param());
      if (!params.success) throw unauthorized();
      const { tenantId, tool } = params.data;
      const services = c.get("req").services();
      const voice = voiceDepsFor(services, c);
      if (!voice.elevenlabs) throw new HttpError(503, "not_configured", "calls aren't set up here");
      const callId = z.uuid().safeParse(c.req.header("x-mezonas-call"));
      const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
      if (
        !callId.success ||
        !(await verifyVoiceToolToken({
          secret: voice.elevenlabs.webhookSecret,
          tenantId,
          callId: callId.data,
          token,
        }))
      ) {
        throw unauthorized();
      }
      const text = await readText(c.req.raw, TOOL_BODY_MAX);
      let body: unknown = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        throw new HttpError(400, "invalid_body", "the body is not JSON");
      }
      const now = new Date();

      const scope = await withTenant(services.db, tenantId, async (tx): Promise<CallScope> => {
        const found = await callByCallId(tx, tenantId, callId.data);
        const request = found.request?.payload;
        const call = found.call?.payload;
        const row = found.call?.row ?? found.request?.row;
        if (!row || (!request && !call)) throw unauthorized();
        const agentVersionId = request?.agentVersionId ?? call?.agentVersionId;
        if (!agentVersionId) throw unauthorized();
        const maxMinutes = request?.settings.maxMinutes ?? call?.maxMinutes ?? 10;
        const over =
          (await findByPayload(tx, tenantId, CALL_ENTITIES.transcript, "callId", callId.data))
            .length > 0 || now.getTime() - row.syncedAt.getTime() > maxMinutes * 60_000 + GRACE_MS;
        if (over) throw new HttpError(409, "call_over", "this call is over");
        return {
          callId: callId.data,
          connectionId: row.connectionId,
          agentVersionId,
          runId: request?.runId ?? null,
          stepRunId: request?.stepRunId ?? null,
          tools: request?.settings.tools ?? call?.tools ?? [],
          callSid: found.call?.row.externalId ?? null,
        };
      });

      const store = (payload: object, entityType = TWILIO_CALL_TOOL_ENTITY) =>
        withTenant(services.db, tenantId, async (tx) => {
          await storeOnce(tx, {
            tenantId,
            connectionId: scope.connectionId,
            entityType,
            externalId: crypto.randomUUID(),
            payload,
            at: new Date(),
          });
        });

      if (tool === FOLLOW_UP_TOOL) {
        const f = FollowUp.safeParse(body);
        if (!f.success) throw new HttpError(422, "invalid_input", "say what they asked for");
        await store(
          { callId: scope.callId, callSid: scope.callSid, what: f.data.what },
          CALL_ENTITIES.followUp,
        );
        return c.json({
          result:
            "Noted. Nothing has changed yet: a person will review it after the call and confirm.",
        });
      }

      const toolId = toolIdOfVoiceName(tool);
      // DECISION: during a call only the step's own tools that read may run; a write is refused
      // here whatever the step lists, before the gate, so nothing on a call changes a client's tool.
      if (!scope.tools.includes(toolId)) {
        throw new HttpError(403, "not_allowed", "that tool isn't one this call may use");
      }
      const registered = services.platform.tools.get(toolId);
      if (registered?.spec.sideEffect !== "none") {
        throw new HttpError(403, "read_only", "on a call the agent can only look things up");
      }

      // A live release lets the call's tools through; nothing on a call asks for one (§1.26).
      const base = createDbPorts(services.db, {
        emit: senseEmitter(services.platform.events),
        release: coverOnlyReleasePort({ db: services.db }),
      });
      const ports = { ...base, log: callToolLog(base.log, scope, (r) => store(r)) };
      const runtime: RuntimeDeps = {
        ports,
        tools: services.platform.tools,
        catalog: services.platform.catalog,
        // Reads only: the gate calls no model here.
        transport: workerTransport(services.env),
        ...(services.env.ENCRYPTION_KEY
          ? { credentials: credentialsFor(services.db, credentialKeysFromEnv(services.env)) }
          : {}),
        services: connectorServicesFor(services.db, { voice, platform: services.platform }),
        // P-1: a pack's read tools on a call (no model: transport null).
        packServices: { db: services.db, transport: null },
      };
      const pinned = await ports.store.loadAgentVersion(tenantId, scope.agentVersionId);
      // The call's tools are the agent's own tools too: a step can't give the voice agent more
      // than its version allows (invariant 9).
      const own = new Set([
        ...pinned.bundle.definition.extraTools,
        ...pinned.bundle.definition.skills.map((s) => s.skill),
      ]);
      if (!own.has(toolId)) {
        throw new HttpError(403, "not_allowed", "that tool isn't one of this agent's tools");
      }
      const step: StepContext = {
        tenantId,
        agent: pinned,
        runId: scope.runId ?? scope.callId,
        stepRunId: scope.stepRunId ?? scope.callId,
        stepId: `call:${scope.callId}`,
        mode: "live",
        externalIndex: { next: 0 },
      };
      const outcome = await callTool(runtime, step, {
        toolId,
        input: body,
        allowed: new Set(scope.tools),
      });
      if (outcome.status === "done") return c.json({ result: outcome.output });
      if (outcome.status === "refused") throw new HttpError(403, "refused", outcome.reason);
      if (outcome.status === "failed") throw new HttpError(422, "tool_failed", outcome.error);
      // A write would have waited for a person: it never gets here (refused above).
      throw new HttpError(403, "read_only", "on a call the agent can only look things up");
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post(routes.elevenlabsPostCall.path, async (c) => {
    try {
      const services = c.get("req").services();
      const voice = voiceDepsFor(services, c);
      if (!voice.elevenlabs) throw new HttpError(503, "not_configured", "calls aren't set up here");
      const text = await readText(c.req.raw, POST_CALL_MAX);
      const now = new Date();
      const ok = await verifyElevenLabsSignature({
        secret: voice.elevenlabs.webhookSecret,
        header: c.req.header("elevenlabs-signature"),
        body: text,
        now,
      });
      if (!ok) throw unauthorized();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new HttpError(400, "invalid_body", "the body is not JSON");
      }
      const post = parsePostCall(json);
      // Other kinds (audio, failures to start) are acknowledged and ignored.
      if (!post) return c.json({ ok: true as const });
      const tenantId = z.uuid().safeParse(post.tenantId);
      const callId = z.uuid().safeParse(post.callId);
      if (!tenantId.success || !callId.success) {
        throw new HttpError(400, "invalid_body", "the call's variables are missing");
      }
      const collect: EventRow[] = [];
      await withTenant(services.db, tenantId.data, async (tx) => {
        const tid = tenantId.data;
        const found = await callByCallId(tx, tid, callId.data);
        const call = found.call;
        if (!call) throw new HttpError(404, "not_found", "no such call");
        const request: CallRequestPayload | undefined = found.request?.payload;
        const p: CallPayload = call.payload;
        // The conversation must be the one we handed this call to.
        const voiceAgentId = p.voiceAgentId ?? request?.voiceAgentId ?? null;
        if (voiceAgentId !== post.agentId) throw unauthorized();
        const callSid = call.row.externalId;
        const transcript: TranscriptPayload = {
          callId: callId.data,
          callSid,
          conversationId: post.conversationId,
          recordOk: post.recordOk,
          // DECISION: without the person's yes to a written record we keep nothing of what was
          // said, not even the summary: only that the call happened, its length and outcome.
          transcript: post.recordOk ? post.transcript : [],
          summary: post.recordOk ? post.summary : null,
          durationSecs: post.durationSecs,
        };
        const stored = await storeOnce(tx, {
          tenantId: tid,
          connectionId: call.row.connectionId,
          connector: ELEVENLABS_CONNECTOR_ID,
          entityType: CALL_ENTITIES.transcript,
          externalId: post.conversationId,
          payload: transcript,
          at: now,
        });
        // Delivered before: acknowledged, nothing more.
        if (!stored) return;
        const minutes = post.durationSecs ? Math.max(1, Math.round(post.durationSecs / 60)) : null;
        await threadCallLine(tx, {
          tenantId: tid,
          contactId: p.contactId,
          direction: p.direction,
          text: post.recordOk
            ? `Call${minutes ? `, ${minutes} min` : ""}: ${post.summary ?? "no summary"}`
            : "Call ended. They didn't agree to a written record, so we kept none.",
          callSid,
          rawRecordId: stored,
          status: "completed",
          agentVersionId: p.agentVersionId ?? request?.agentVersionId ?? null,
        });

        // What they asked to change goes to the inbox, for a person.
        const followUps = await findByPayload(
          tx,
          tid,
          CALL_ENTITIES.followUp,
          "callId",
          callId.data,
        );
        if (followUps.length > 0) {
          const agentId = p.agentId ?? request?.agentId ?? null;
          const [a] = agentId
            ? await tx
                .select({ approver: agent.approver, bundle: agentVersion.bundle })
                .from(agent)
                .leftJoin(agentVersion, eq(agentVersion.id, agent.liveVersionId))
                .where(and(eq(agent.tenantId, tid), eq(agent.id, agentId)))
            : [];
          const [t] = await tx
            .select({ settings: tenant.settings })
            .from(tenant)
            .where(eq(tenant.id, tid));
          const who: Assignee = resolveApprover([
            a?.bundle?.definition.permissions.approver,
            a?.approver,
            clientApproverSetting((t?.settings ?? {}) as Record<string, unknown>),
          ]);
          for (const f of followUps) {
            const what = String((f.payload as { what?: unknown }).what ?? "");
            await tx.insert(inboxItem).values({
              tenantId: tid,
              kind: "review",
              agentId,
              subjectType: "raw_record",
              subjectId: f.id,
              ...who,
              title: `Asked on a call: ${what}`.slice(0, 200),
              payload: {
                kind: "call_follow_up",
                callSid,
                what,
                contactId: p.contactId,
                // Evidence: the follow-up as noted, and the call's record.
                sources: [f.id, stored],
              },
            });
          }
        }

        const status = await findRecord(tx, tid, CALL_ENTITIES.status, `${callSid}:completed`);
        const done: CallCompletedPayload = {
          connectionId: call.row.connectionId,
          callSid,
          direction: p.direction,
          contactId: p.contactId,
          outcome: "answered",
          durationSecs:
            (status?.payload as { durationSecs?: number | null } | undefined)?.durationSecs ??
            post.durationSecs,
          rawRecordId: call.row.id,
          followUps: followUps.length,
          at: now.toISOString(),
        };
        const ev = await emit(
          tx,
          {
            tenantId: tid,
            type: CALL_COMPLETED_EVENT,
            subjectType: "raw_record",
            subjectId: call.row.id,
            payload: done,
          },
          { registry: services.platform.events },
        );
        if (ev) collect.push(ev);
      });
      if (collect.length > 0) {
        c.get("req").deferred.push(() =>
          dispatchEvents({ db: services.db, instances: services.instances }, collect),
        );
      }
      return c.json({ ok: true as const });
    } catch (error) {
      return errorResponse(c, error);
    }
  });
}
