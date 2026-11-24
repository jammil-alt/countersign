// Collect reports (owner, 2026-11-24): a report emailed to its step's address, the agent's own
// address with `+<step id>` (core `agentStepAddress`). The sender must be proven (DMARC) and be
// the contact a link of that step is open for; the files go to that link as if they had been
// uploaded on its page, so the step checks them as it checks any upload, asks again when they
// don't pass, and stops following up when they do. Mail to a step never starts a run.

import { acceptsFile, type FormDefinition, processes } from "@countersign/core";
import { formRequest, type Tx } from "@countersign/db";
import { and, asc, eq, sql } from "drizzle-orm";

/** The tags of the collect steps in an agent's enabled workflows (`stepTag` of each id). */
export function collectStepTags(bundle: {
  workflows: readonly { enabled: boolean; workflow: unknown }[];
}): Set<string> {
  const out = new Set<string>();
  for (const wf of bundle.workflows) {
    if (!wf.enabled) continue;
    const parsed = processes.Process.safeParse(wf.workflow);
    if (!parsed.success) continue;
    for (const { step } of processes.allSteps(parsed.data)) {
      if (step.kind === "collect") out.add(step.id.toLowerCase());
    }
  }
  return out;
}

/** Whether a link's node (`<step>:<i>:r<n>:ask`, maybe inside a loop) belongs to the step. */
export function linkOfStep(nodeId: string, tag: string): boolean {
  const segs = nodeId.toLowerCase().split(":");
  const n = segs.length;
  return (
    n >= 4 &&
    segs[n - 1] === "ask" &&
    /^r\d+$/.test(segs[n - 2] as string) &&
    /^\d+$/.test(segs[n - 3] as string) &&
    segs[n - 4] === tag
  );
}

export interface EmailedFile {
  id: string;
  filename: string;
  mimeType: string;
}

export interface HandedTo {
  formRequestId: string;
  runId: string;
  reachOutId: string | null;
}

type LinkRow = typeof formRequest.$inferSelect;

/** The step's links open for this contact, due first first. */
export async function openLinks(
  tx: Tx,
  input: { tenantId: string; agentId: string; tag: string; contactId: string; at: Date },
): Promise<LinkRow[]> {
  const rows = await tx
    .select()
    .from(formRequest)
    .where(
      and(
        eq(formRequest.tenantId, input.tenantId),
        eq(formRequest.agentId, input.agentId),
        eq(formRequest.contactId, input.contactId),
        eq(formRequest.status, "open"),
      ),
    )
    .orderBy(asc(formRequest.dueAt));
  return rows.filter(
    (r) => linkOfStep(r.nodeId, input.tag) && r.dueAt.getTime() > input.at.getTime(),
  );
}

/**
 * Gives the files to one of the open links: the one whose report takes every file's format, else
 * the one due first. Null when it was answered or closed meanwhile.
 */
// DECISION: when one owner has two reports open on the step, the files go to the report that takes
// all of them, then to the one due first; a file in the wrong report fails its checks there and
// the owner is asked again with the reason, as with an upload.
export async function handToOpenLink(
  tx: Tx,
  input: {
    open: readonly LinkRow[];
    tenantId: string;
    files: readonly EmailedFile[];
    at: Date;
    messageId: string | null;
  },
): Promise<HandedTo | null> {
  const { open } = input;
  if (open.length === 0 || input.files.length === 0) return null;
  const question = (r: LinkRow) =>
    (r.definition as unknown as FormDefinition).questions.find(
      (q) => q.id === processes.COLLECT_FILE_QUESTION && q.type === "files",
    );
  const takesAll = open.find((r) => {
    const q = question(r);
    return q?.type === "files" && input.files.every((f) => acceptsFile(q, f.mimeType));
  });
  const chosen = takesAll ?? open[0];
  if (!chosen) return null;
  const answer = input.files.map((f) => ({ documentId: f.id, filename: f.filename }));
  const answers = { [processes.COLLECT_FILE_QUESTION]: answer };
  const [updated] = await tx
    .update(formRequest)
    .set({
      status: "submitted",
      answers,
      draft: answers,
      submittedAt: input.at,
      documents: sql`${formRequest.documents} || ${JSON.stringify(input.files.map((f) => f.id))}::jsonb`,
      log: sql`${formRequest.log} || ${JSON.stringify([
        {
          at: input.at.toISOString(),
          kind: "emailed",
          documents: input.files.map((f) => f.id),
          messageId: input.messageId,
        },
      ])}::jsonb`,
    })
    .where(
      and(
        eq(formRequest.id, chosen.id),
        eq(formRequest.tenantId, input.tenantId),
        eq(formRequest.status, "open"),
      ),
    )
    .returning({
      id: formRequest.id,
      runId: formRequest.runId,
      reachOutId: formRequest.reachOutId,
    });
  return updated
    ? { formRequestId: updated.id, runId: updated.runId, reachOutId: updated.reachOutId }
    : null;
}
