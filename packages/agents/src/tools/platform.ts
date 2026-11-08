// Platform tools that need no domain (ARCHITECTURE §9.4): inbox.create, memory.write; threads.post
// and threads.read live in ./threads (v0.12 W1-C).
// Each writes the platform's own records (`internal`), through the PlatformStore port.

import { z } from "zod";
// v0.12 W2-D
import { ACCOUNT_TOOLS } from "./account";
import { agentsAsk } from "./ask";
// P-4
import { converseTool } from "./converse";
import { DIRECTORY_TOOLS } from "./directory";
import { DOCS_TOOLS } from "./docs";
import { HEALTH_TOOLS } from "./health";
// v0.12 W2-E
import { INBOUND_TOOLS } from "./inbound";
import { KNOWLEDGE_TOOLS } from "./knowledge";
import { memoryScope } from "./memory-scope";
import { reachOutTool } from "./reach";
import { SUPERVISOR_TOOLS } from "./supervisor";
import { THREADS_TOOLS } from "./threads";
import { defineInternalTool, type InternalTool } from "./types";

export { MEMORY_TEST_SCOPE_PREFIX, memoryScope } from "./memory-scope";

const Uuid = z.uuid();

export const inboxCreate = defineInternalTool({
  id: "inbox.create",
  description:
    "Ask a person for something: a review, a missing document or an answer. Creates an inbox item for the client's admin (or the operator).",
  sideEffect: "internal",
  verb: "create",
  summary: "Asked a person: {{title}}",
  input: z.object({
    kind: z.enum(["review", "request"]).default("request"),
    title: z.string().min(1).max(200),
    details: z.string().max(4000).default(""),
    /** Record ids the request is about (CLAUDE.md invariant 10). */
    sources: z.array(z.string().min(1)).default([]),
    assignee: z.enum(["client_admin", "operator"]).default("client_admin"),
    subjectType: z.string().min(1).optional(),
    subjectId: Uuid.optional(),
  }),
  output: z.object({ inboxItemId: z.string(), title: z.string() }),
  async run(input, ctx) {
    // DECISION: a test run's inbox items go to the operator, never the client, because test runs
    // are hidden from the portal (ARCHITECTURE §10.4); they carry the run id as their tag.
    const test = ctx.mode === "test";
    const item = await ctx.platform.createInboxItem(ctx.tenantId, {
      kind: input.kind,
      title: input.title,
      payload: {
        details: input.details,
        sources: input.sources,
        stepId: ctx.stepId,
        ...(test ? { testRunId: ctx.runId } : {}),
      },
      agentId: ctx.agentId,
      runId: ctx.runId,
      subjectType: input.subjectType ?? null,
      subjectId: input.subjectId ?? null,
      assigneeRole: test ? "operator" : input.assignee,
    });
    return { inboxItemId: item.id, title: input.title };
  },
});

export const memoryWrite = defineInternalTool({
  id: "memory.write",
  description:
    "Save a short note to remember for this client next time (e.g. how this client names things). Never store secrets.",
  sideEffect: "internal",
  verb: "create",
  input: z.object({ note: z.string().min(1).max(2000) }),
  output: z.object({ memoryNoteId: z.string() }),
  async run(input, ctx) {
    const saved = await ctx.platform.writeMemory(ctx.tenantId, {
      agentId: ctx.agentId,
      note: input.note,
      scope: memoryScope(ctx.mode, ctx.runId),
    });
    return { memoryNoteId: saved.id };
  },
});

/**
 * The platform's own tools, for the tool registry: inbox, threads, memory, documents, knowledge,
 * the health tools, asking another agent and the supervisor's (docs/plan.md §1.28).
 */
export const PLATFORM_TOOLS: readonly InternalTool[] = [
  inboxCreate,
  ...THREADS_TOOLS,
  memoryWrite,
  ...DOCS_TOOLS,
  ...KNOWLEDGE_TOOLS,
  ...DIRECTORY_TOOLS,
  reachOutTool,
  // P-4: conversations
  converseTool,
  ...HEALTH_TOOLS,
  agentsAsk,
  ...SUPERVISOR_TOOLS,
  // v0.12 W2-D: Sloan's account tools
  ...ACCOUNT_TOOLS,
  // v0.12 W2-E
  ...INBOUND_TOOLS,
];
