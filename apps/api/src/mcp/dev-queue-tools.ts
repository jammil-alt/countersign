// The Dev queue's MCP tools (docs/plan.md §1.125), on both servers (staging and production run the
// same code): what a Claude Code session needs to find a request, build it and hand it back. They
// call the same service as the back office's Dev queue tab (../dev-queue/service.ts), so the guards
// and events are the same; the session is recorded as `session`. Claiming, notes, the reuse check
// and attaching a PR change only the request and need no confirm; accepting and closing are a
// person's decisions, so they take the two-step confirm, as feedback_resolve does. Shipped is the
// system's, never a tool's.

import {
  CloseReason,
  type CODE_REQUEST_KINDS,
  CODE_REQUEST_STATUSES,
  CodeRequestKind,
  isUuid,
} from "@countersign/core";
import { z } from "zod";
import { type AuditEntry, auditAlone } from "../audit";
import {
  acceptRequest,
  attachPr,
  claimRequest,
  closeRequest,
  type DqCtx,
  getRequest,
  listRequests,
  noteRequest,
  rerunReuse,
  searchParts,
} from "../dev-queue/service";
import { auditActor, HttpError, inScope, scopeOf, toHttpError } from "../http";
import {
  CONFIRM_ARG,
  CONFIRM_TTL_SEC,
  checkConfirmToken,
  claimNonce,
  issueConfirmToken,
} from "./confirm";
import type { OpsToolCtx } from "./ops-tools";
import { dataResult } from "./output";
import type { Tool } from "./protocol";

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const Ref = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .describe("A request's id (uuid) or its number, e.g. DQ-012");

/**
 * The Dev queue's work as this operator, in the operator's scope (short transactions, so the
 * reuse check's model call runs outside one), audited once: ok when it returns, refused or error
 * when it throws.
 */
async function asSession<T>(
  ctx: OpsToolCtx,
  tool: string,
  target: Record<string, string>,
  work: (dq: DqCtx) => Promise<T>,
): Promise<T> {
  const scope = scopeOf(ctx.session, ["operator"], "ops");
  const db = ctx.c.get("req").services().db;
  const entry = (outcome: AuditEntry["outcome"], httpStatus: number): AuditEntry => ({
    ...auditActor(ctx.session),
    tenantId: null,
    action: `${ctx.via ?? "mcp"} tool ${tool}`,
    outcome,
    httpStatus,
    target: Object.fromEntries(Object.entries(target).map(([k, v]) => [k, v.slice(0, 200)])),
  });
  try {
    if (!scope.ok) throw new HttpError(scope.status, scope.code, scope.message);
    const out = await work({
      services: ctx.c.get("req").services(),
      inTx: (fn) => inScope(ctx.c, scope, fn),
      userId: ctx.session.user.id,
      actor: "session",
      now: () => ctx.now(),
    });
    await auditAlone(db, ctx.c, entry("ok", 200));
    return out;
  } catch (error) {
    const status = toHttpError(error).status;
    await auditAlone(db, ctx.c, entry(status >= 500 ? "error" : "refused", status));
    throw error;
  }
}

const codeRequestsList: Tool<OpsToolCtx> = {
  name: "code_requests_list",
  title: "List Dev queue requests",
  description:
    "The Dev queue: requests for code the Builder or an operator filed, newest first, with number (DQ-012), title, kind, status (In progress with a PR is in review), linked builds, owner, PR and where it shipped. Filter by status (open by default: triage, accepted and in progress), kind, a build's id, or environment (shipped there).",
  input: z.strictObject({
    status: z.enum([...CODE_REQUEST_STATUSES, "open", "all"]).default("open"),
    kind: CodeRequestKind.optional(),
    build: z.string().refine(isUuid, "not an id").optional().describe("A build's id"),
    environment: z.enum(["staging", "production"]).optional(),
    limit: z.int().min(1).max(200).default(50),
  }),
  annotations: READ,
  async run(ctx, args) {
    const a = args as {
      status: string;
      kind?: (typeof CODE_REQUEST_KINDS)[number];
      build?: string;
      environment?: "staging" | "production";
      limit: number;
    };
    const out = await asSession(ctx, "code_requests_list", { status: a.status }, (dq) =>
      dq.inTx(({ tx }) => listRequests(tx, a)),
    );
    return dataResult(
      "code_requests_list",
      `${out.requests.length} requests (${a.status}); ${out.openCount} open in all. code_request_get shows one.`,
      out,
    );
  },
};

const codeRequestGet: Tool<OpsToolCtx> = {
  name: "code_request_get",
  title: "Get a Dev queue request",
  description:
    "One request by id or number (DQ-012): its spec (summary, inputs, outputs, rules, acceptance, the part), open questions, the reuse check (each candidate's verdict and what it lacks), the decision and reason, linked builds and steps, the PR, where it shipped, the events, and each move with why it is or isn't allowed now.",
  input: z.strictObject({ id: Ref }),
  annotations: READ,
  async run(ctx, args) {
    const { id } = args as { id: string };
    const request = await asSession(ctx, "code_request_get", { request: id }, (dq) =>
      getRequest(dq, id),
    );
    return dataResult("code_request_get", `${request.ref}, ${request.status}.`, { request });
  },
};

const catalogSearch: Tool<OpsToolCtx> = {
  name: "catalog_search",
  title: "Search the catalog",
  description:
    "The reuse check's search: catalog parts (skills, tools, connectors, packs, Reshape data's operations) and open or shipped Dev queue requests, scored by text and by input and output field names. Read each hit's description, inputs and outputs before deciding it does or doesn't do the work: a score is not a verdict.",
  input: z.strictObject({
    query: z.string().trim().min(1).max(500),
    inputs: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    outputs: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    kind: CodeRequestKind.optional(),
    limit: z.int().min(1).max(20).default(8),
  }),
  annotations: READ,
  async run(ctx, args) {
    const a = args as {
      query: string;
      inputs?: string[];
      outputs?: string[];
      kind?: (typeof CODE_REQUEST_KINDS)[number];
      limit: number;
    };
    const hits = await asSession(ctx, "catalog_search", { query: a.query.slice(0, 100) }, (dq) =>
      searchParts(
        dq,
        {
          query: a.query,
          ...(a.inputs ? { inputs: a.inputs } : {}),
          ...(a.outputs ? { outputs: a.outputs } : {}),
          ...(a.kind ? { kind: a.kind } : {}),
        },
        a.limit,
      ),
    );
    return dataResult("catalog_search", `${hits.length} matches, best first.`, { hits });
  },
};

const codeRequestClaim: Tool<OpsToolCtx> = {
  name: "code_request_claim",
  title: "Claim a Dev queue request",
  description:
    "Claim an accepted request to build it (atomic: one session has it). A claim lapses 2 hours after its last event unless its PR is attached; the reuse check runs again on claim, so read it before building: the part may exist now.",
  input: z.strictObject({ id: Ref }),
  annotations: WRITE,
  async run(ctx, args) {
    const { id } = args as { id: string };
    ctx.audit.target = { request: id };
    const request = await asSession(ctx, "code_request_claim", { request: id }, (dq) =>
      claimRequest(dq, id),
    );
    ctx.audit.outcome = "done";
    return dataResult("code_request_claim", `Claimed ${request.ref}.`, { request });
  },
};

const codeRequestNote: Tool<OpsToolCtx> = {
  name: "code_request_note",
  title: "Note on a Dev queue request",
  description:
    "Add a note to a request's timeline: what you found, a part that already does it, a summary of what you did. A note keeps a claim alive.",
  input: z.strictObject({ id: Ref, body: z.string().trim().min(1).max(4000) }),
  annotations: WRITE,
  async run(ctx, args) {
    const { id, body } = args as { id: string; body: string };
    ctx.audit.target = { request: id };
    const request = await asSession(ctx, "code_request_note", { request: id }, (dq) =>
      noteRequest(dq, id, body),
    );
    ctx.audit.outcome = "done";
    return dataResult("code_request_note", `Noted on ${request.ref}.`, { request });
  },
};

const codeRequestRerunReuse: Tool<OpsToolCtx> = {
  name: "code_request_rerun_reuse",
  title: "Run a request's reuse check again",
  description:
    "Run the reuse check again: the catalog search, then the judge's verdict on each candidate (use, extend or reject, with what it lacks).",
  input: z.strictObject({ id: Ref }),
  annotations: WRITE,
  async run(ctx, args) {
    const { id } = args as { id: string };
    ctx.audit.target = { request: id };
    const request = await asSession(ctx, "code_request_rerun_reuse", { request: id }, (dq) =>
      rerunReuse(dq, id),
    );
    ctx.audit.outcome = "done";
    return dataResult("code_request_rerun_reuse", `${request.ref}'s reuse check ran again.`, {
      reuseCheck: request.reuseCheck,
      coveredBy: request.coveredBy,
    });
  },
};

const codeRequestAttachPr: Tool<OpsToolCtx> = {
  name: "code_request_attach_pr",
  title: "Attach a PR to a Dev queue request",
  description:
    "Attach the pull request (https://github.com/<owner>/<repo>/pull/<n>) and the catalog part it adds (a tool id, a skill ref, or `<part>#<operation>` such as data.reshape#dateOffset). Only whoever claimed it. When the PR is merged and deployed, Mezonas sees the part in its catalog and marks the request shipped by itself.",
  input: z.strictObject({
    id: Ref,
    pr_url: z.string().trim().min(1).max(300),
    expected_part_id: z.string().trim().min(1).max(300),
  }),
  annotations: WRITE,
  async run(ctx, args) {
    const a = args as { id: string; pr_url: string; expected_part_id: string };
    ctx.audit.target = { request: a.id };
    const request = await asSession(ctx, "code_request_attach_pr", { request: a.id }, (dq) =>
      attachPr(dq, a.id, a.pr_url, a.expected_part_id),
    );
    ctx.audit.outcome = "done";
    return dataResult("code_request_attach_pr", `PR attached to ${request.ref}.`, { request });
  },
};

const codeRequestSetStatus: Tool<OpsToolCtx> = {
  name: "code_request_set_status",
  title: "Accept or close a Dev queue request",
  description: `A person's decision on a request: accept it (from triage; refused with the reason while its triage isn't done) or close it with a reason (merged needs merged_into). Shipped is the system's. Two steps: call it without confirm_token to see what it will do and get a token; then call it again with the same arguments and that confirm_token. A token works once, for ${CONFIRM_TTL_SEC / 60} minutes, and only for you. Agents never accept or close a request on their own: only on the person's word.`,
  input: z.strictObject({
    id: Ref,
    status: z.enum(["accepted", "closed"]),
    close_reason: CloseReason.optional(),
    merged_into_id: Ref.optional(),
    note: z.string().trim().max(2000).optional(),
    [CONFIRM_ARG]: z
      .string()
      .min(1)
      .max(4000)
      .optional()
      .describe("From the first call's answer; leave out to preview"),
  }),
  annotations: WRITE,
  async run(ctx, args) {
    const a = args as {
      id: string;
      status: "accepted" | "closed";
      close_reason?: z.infer<typeof CloseReason>;
      merged_into_id?: string;
      note?: string;
      [CONFIRM_ARG]?: string;
    };
    if (a.status === "closed" && !a.close_reason) {
      throw new HttpError(422, "close_reason", "closing needs a close_reason");
    }
    const userId = ctx.session.user.id;
    const bound = {
      id: a.id,
      status: a.status,
      ...(a.close_reason ? { close_reason: a.close_reason } : {}),
      ...(a.merged_into_id ? { merged_into_id: a.merged_into_id } : {}),
      ...(a.note ? { note: a.note } : {}),
    };
    ctx.audit.target = { request: a.id };
    const token = a[CONFIRM_ARG];
    if (!token) {
      const request = await asSession(ctx, "code_request_set_status", { request: a.id }, (dq) =>
        getRequest(dq, a.id),
      );
      const move = a.status === "accepted" ? request.moves.accept : request.moves.close;
      if (!move.allowed) throw new HttpError(409, "refused", move.reason);
      const issued = await issueConfirmToken({
        password: ctx.config.sealPassword,
        userId,
        tool: codeRequestSetStatus.name,
        args: bound,
        now: ctx.now(),
      });
      ctx.audit.outcome = "preview";
      const what =
        a.status === "accepted"
          ? `accept ${request.ref} (every operator and its linked builds are told)`
          : `close ${request.ref} as ${a.close_reason}${a.merged_into_id ? `, merged into ${a.merged_into_id}` : ""}`;
      return dataResult(
        "code_request_set_status",
        [
          `Preview, nothing changed yet. This will ${what}, as you, in Mezonas ${ctx.config.environment}.`,
          `To do it, call code_request_set_status again with the same arguments and confirm_token "${issued.token}" (it expires at ${issued.expiresAt.toISOString()}).`,
        ].join("\n"),
        { request },
      );
    }
    const checked = await checkConfirmToken({
      token,
      password: ctx.config.sealPassword,
      userId,
      tool: codeRequestSetStatus.name,
      args: bound,
      now: ctx.now(),
    });
    if (!checked.ok) {
      const why = {
        invalid: "that confirm token is not valid",
        expired: "that confirm token has expired; preview again for a new one",
        mismatch:
          "that confirm token was for different arguments (or another user); preview again with these",
        used: "that confirm token was already used",
      }[checked.reason];
      throw new HttpError(422, `confirm_${checked.reason}`, why);
    }
    if (!(await claimNonce(ctx.objects, checked.nonce, ctx.now()))) {
      throw new HttpError(422, "confirm_used", "that confirm token was already used");
    }
    // A person's word, carried by the session: recorded as the operator's decision.
    const request = await asSession(
      ctx,
      "code_request_set_status",
      { request: a.id, result: "done" },
      (dq) =>
        a.status === "accepted"
          ? acceptRequest({ ...dq, actor: "operator" }, a.id)
          : closeRequest(
              { ...dq, actor: "operator" },
              a.id,
              a.close_reason as z.infer<typeof CloseReason>,
              a.merged_into_id ?? null,
              a.note ?? null,
            ),
    );
    ctx.audit.outcome = "done";
    return dataResult(
      "code_request_set_status",
      a.status === "accepted" ? `${request.ref} accepted.` : `${request.ref} closed.`,
      { request },
    );
  },
};

export const DEV_QUEUE_TOOLS: readonly Tool<OpsToolCtx>[] = [
  codeRequestsList,
  codeRequestGet,
  catalogSearch,
  codeRequestClaim,
  codeRequestNote,
  codeRequestRerunReuse,
  codeRequestAttachPr,
  codeRequestSetStatus,
];
