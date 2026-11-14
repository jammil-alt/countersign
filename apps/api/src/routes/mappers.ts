// Rows → response shapes. Dates become ISO strings; permission matrices are filled with defaults.

import {
  type AgentRow,
  type AgentVersionRow,
  type Approver,
  mayResolve,
} from "@countersign/agents";
import { normalizeMatrix } from "@countersign/connectors";
import type { PermissionMatrix } from "@countersign/core";
import type {
  connection,
  externalAction,
  inboxItem,
  run,
  stepRun,
  toolCall,
} from "@countersign/db";
import { changeDisplay, itemDisplay } from "../change-display";
import { iso } from "../http";
import type { Platform } from "../platform";

type ConnectionRow = typeof connection.$inferSelect;
type RunRow = typeof run.$inferSelect;
type StepRunRow = typeof stepRun.$inferSelect;
type ToolCallRow = typeof toolCall.$inferSelect;
type ActionRow = typeof externalAction.$inferSelect;
type InboxRow = typeof inboxItem.$inferSelect;
type Registries = Pick<Platform, "tools" | "connectors">;

export function agentSummary(a: AgentRow) {
  return {
    id: a.id,
    tenantId: a.tenantId,
    kind: a.kind,
    slug: a.slug,
    name: a.name,
    role: a.role,
    templateId: a.templateId,
    linked: a.linked,
    liveVersionId: a.liveVersionId,
    status: a.status,
    runStatus: a.runStatus,
    serviceName: a.serviceName,
    serviceDescription: a.serviceDescription,
    bindings: a.bindings,
    approver: a.approver,
    testCopy: a.testCopy,
    stage: a.stage ?? null,
    createdAt: a.createdAt.toISOString(),
  };
}

export function versionSummary(v: Omit<AgentVersionRow, "bundle">) {
  return {
    id: v.id,
    agentId: v.agentId,
    version: v.version,
    status: v.status,
    bundleHash: v.bundleHash,
    changeNote: v.changeNote,
    releaseNote: v.releaseNote,
    authorType: v.authorType,
    authorId: v.authorId,
    parentVersionId: v.parentVersionId,
    basedOnTemplateVersionId: v.basedOnTemplateVersionId,
    mergedFromVersionIds: v.mergedFromVersionIds,
    createdAt: v.createdAt.toISOString(),
  };
}

export function versionDetail(v: AgentVersionRow) {
  return { ...versionSummary(v), bundle: v.bundle };
}

/** Never the credentials. */
export function opsConnection(c: ConnectionRow) {
  return {
    id: c.id,
    tenantId: c.tenantId,
    connector: c.connector,
    status: c.status,
    externalAccountId: c.externalAccountId,
    config: c.config,
    permissions: normalizeMatrix(c.permissions),
    lastSyncAt: iso(c.lastSyncAt),
    connectedBy: c.connectedBy,
    createdAt: c.createdAt.toISOString(),
  };
}

// Speed run 6.3: the run lists select only these columns (`runListColumns` in ops-clients.ts).
export function opsRun(
  r: Pick<
    RunRow,
    | "id"
    | "tenantId"
    | "agentId"
    | "agentVersionId"
    | "workflowSlug"
    | "mode"
    | "status"
    | "trigger"
    | "costUsd"
    | "error"
    | "startedAt"
    | "finishedAt"
    | "createdAt"
  >,
) {
  return {
    id: r.id,
    tenantId: r.tenantId,
    agentId: r.agentId,
    agentVersionId: r.agentVersionId,
    workflowSlug: r.workflowSlug,
    mode: r.mode,
    status: r.status,
    trigger: r.trigger,
    costUsd: r.costUsd,
    error: r.error ?? null,
    startedAt: iso(r.startedAt),
    finishedAt: iso(r.finishedAt),
    createdAt: r.createdAt.toISOString(),
  };
}

export function opsStep(s: StepRunRow) {
  return {
    id: s.id,
    nodeId: s.nodeId,
    nodeType: s.nodeType,
    skillRef: s.skillRef,
    status: s.status,
    input: s.input ?? null,
    output: s.output ?? null,
    summary: s.summary,
    costUsd: s.costUsd,
    tokensIn: s.tokensIn,
    tokensOut: s.tokensOut,
    startedAt: iso(s.startedAt),
    finishedAt: iso(s.finishedAt),
    // Step panel (§1.95)
    attempts: s.attempts,
  };
}

// Speed run 6.2: the run page selects only these columns.
export function opsToolCall(t: Omit<ToolCallRow, "tenantId" | "createdAt">) {
  return {
    id: t.id,
    stepRunId: t.stepRunId,
    tool: t.tool,
    input: t.input ?? null,
    output: t.output ?? null,
    status: t.status,
    durationMs: t.durationMs,
    externalActionId: t.externalActionId,
  };
}

export function opsAction(a: ActionRow, platform: Registries) {
  return {
    id: a.id,
    tool: a.tool,
    display: changeDisplay(platform, a.tool),
    connectionId: a.connectionId,
    stepRunId: a.stepRunId,
    status: a.status,
    input: a.input,
    before: a.before ?? null,
    result: a.result ?? null,
    error: a.error ?? null,
    inboxItemId: a.inboxItemId,
    approvedBy: a.approvedBy,
    approvedAt: iso(a.approvedAt),
    executedAt: iso(a.executedAt),
    // v0.12 W1-D: the signer's edit before signing; `input` stays the agent's (both show).
    editedInput: a.editedInput ?? null,
    editedBy: a.editedBy,
    editedAt: iso(a.editedAt),
  };
}

/** An inbox item for the back office; `operator` is the signed-in operator in the item's client. */
export function opsInboxItem(i: InboxRow, operator: Approver, platform: Registries) {
  return {
    id: i.id,
    tenantId: i.tenantId,
    kind: i.kind,
    agentId: i.agentId,
    runId: i.runId,
    subjectType: i.subjectType,
    subjectId: i.subjectId,
    assigneeRole: i.assigneeRole,
    assigneeUserId: i.assigneeUserId,
    title: i.title,
    payload: i.payload,
    display: itemDisplay(platform, i),
    status: i.status,
    resolution: i.resolution ?? null,
    resolvedBy: i.resolvedBy,
    dueAt: iso(i.dueAt),
    createdAt: i.createdAt.toISOString(),
    resolvedAt: iso(i.resolvedAt),
    resolvableByOperator: mayResolve(i, operator),
    // v0.12 W1-D: the Desk's undo window, snooze and batch.
    deliverAfter: iso(i.deliverAfter),
    snoozedUntil: iso(i.snoozedUntil),
    batchKey: i.batchKey,
  };
}

/** A matrix edit from a request body, without the keys it left out. */
export function matrixEdit(
  edit: {
    [K in keyof PermissionMatrix]?: PermissionMatrix[K] | undefined;
  },
): Partial<PermissionMatrix> {
  const out: Partial<PermissionMatrix> = {};
  for (const [k, v] of Object.entries(edit)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
