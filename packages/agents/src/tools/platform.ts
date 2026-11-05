// Platform tools that need no domain (ARCHITECTURE §9.4): inbox.create, threads.post, memory.write.
// Each writes the platform's own records (`internal`), through the PlatformStore port.

import { z } from "zod";
import { DIRECTORY_TOOLS } from "./directory";
import { DOCS_TOOLS } from "./docs";
import { KNOWLEDGE_TOOLS } from "./knowledge";
import { memoryScope } from "./memory-scope";
import { reachOutTool } from "./reach";
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

export const threadsPost = defineInternalTool({
  id: "threads.post",
  description:
    "Post a note to the run's thread (or a thread about a subject), citing the records it rests on. Notes are for the operator.",
  sideEffect: "internal",
  verb: "create",
  input: z.object({
    text: z.string().min(1).max(8000),
    sources: z.array(z.string().min(1)).default([]),
    threadId: Uuid.optional(),
    subject: z
      .object({ type: z.string().min(1), id: Uuid.nullable().default(null), title: z.string() })
      .optional(),
  }),
  output: z.object({ messageId: z.string(), threadId: z.string() }),
  async run(input, ctx) {
    const threadId = input.threadId ?? ctx.threadId;
    if (!threadId && !input.subject) {
      throw new Error("threads.post needs a thread: this run has none, so name a subject");
    }
    // DECISION: messages agents post are for the operator only. Model text reaches the portal
    // only through skill and tool summary templates (docs/plan.md §1.2 "Client run timeline").
    const posted = await ctx.platform.postMessage(ctx.tenantId, {
      threadId,
      subject: input.subject,
      agentVersionId: ctx.agentVersionId,
      body: {
        text: input.text,
        stepId: ctx.stepId,
        runId: ctx.runId,
        ...(ctx.mode === "test" ? { testRunId: ctx.runId } : {}),
      },
      sources: input.sources,
      audience: "operator",
    });
    return { messageId: posted.id, threadId: posted.threadId };
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

/** The platform's own tools, for the tool registry: inbox, threads, memory, documents, knowledge. */
export const PLATFORM_TOOLS: readonly InternalTool[] = [
  inboxCreate,
  threadsPost,
  memoryWrite,
  ...DOCS_TOOLS,
  ...KNOWLEDGE_TOOLS,
  ...DIRECTORY_TOOLS,
  reachOutTool,
];
