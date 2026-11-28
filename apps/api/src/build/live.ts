// A build goes live when its draft is published (owner, 2026-11-27: "just go from draft to
// publish"). One way for every place a draft is published: the build's own Publish, the steps
// page's (and the MCP server's agent_publish, the same route), and Turn on. The build is marked
// live with a decision event and one line in the conversation. Publishing itself is the back
// office's own (validation, refusals, invariant 8 and 11 untouched): a template's publish changes no
// client agent, and a client's agent is tried at the client in its go-live stages after it.

import { build, buildItem, type Tx } from "@countersign/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { addEvent, addMessage, asDraft, type BuildRow } from "./store";

/** What the conversation says once the draft is published. */
export function publishedText(row: Pick<BuildRow, "kind" | "clientId">, version: number | null) {
  const v = version !== null ? `Published v${version}.` : "Published.";
  if (row.kind === "skill") {
    return `${v} This build is done: agents that use the skill without a set version run it now.`;
  }
  return row.clientId
    ? `${v} This build is done. Next it's tried at the client with their real data and systems: activate it to start its trial, where the client signs every write.`
    : `${v} This build is done. No client's agent changes until it is turned on or updated there.`;
}

/**
 * Marks an open build (read and locked by the caller, in this transaction) live: its draft was
 * just published (or already was). A skill build settles the issue that started it.
 */
export async function goLive(
  tx: Tx,
  row: BuildRow,
  input: { userId: string; versionId: string | null; version: number | null; text?: string },
): Promise<void> {
  if (row.status !== "open") return;
  // The stored phase is the draft's from now on, whatever retired phase it was in before.
  await tx.update(build).set({ status: "live", phase: "draft" }).where(eq(build.id, row.id));
  await addEvent(tx, row, {
    kind: "decision",
    payload: { go: true, published: input.versionId },
    userId: input.userId,
  });
  await addMessage(tx, row, {
    role: "builder",
    text: input.text ?? publishedText(row, input.version),
  });
  // docs/plan.md §1.169: a skill build that goes live settles the issue that started it.
  if (row.kind === "skill") {
    const note = "Settled: its skill build went live.";
    await tx
      .update(buildItem)
      .set({
        state: "done",
        resolvedAt: new Date(),
        detail: sql`left(case when ${buildItem.detail} = '' then ${note} else ${buildItem.detail} || ${`\n${note}`} end, 2000)`,
      })
      .where(
        and(
          sql`${buildItem.ref}->>'buildId' = ${row.id}`,
          inArray(buildItem.state, ["open", "in_progress", "waiting", "deferred"]),
        ),
      );
  }
}

/**
 * An agent's version was published: its open build, if it has one, goes live with it. Called in
 * the publish's own transaction, so the build and the agent change together.
 */
export async function liveOnPublish(
  tx: Tx,
  input: {
    agentId: string;
    versionId: string;
    version: number;
    userId: string;
    text?: (row: BuildRow) => string;
  },
): Promise<void> {
  const open = await tx
    .select()
    .from(build)
    .where(and(eq(build.agentId, input.agentId), eq(build.kind, "agent"), eq(build.status, "open")))
    .for("update");
  for (const row of open.map(asDraft)) {
    await goLive(tx, row, {
      userId: input.userId,
      versionId: input.versionId,
      version: input.version,
      ...(input.text ? { text: input.text(row) } : {}),
    });
  }
}
