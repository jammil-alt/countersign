// A build at its client (docs/plan.md §1.108, §1.170): what the client-test move and Turn on share.
// Both copy a template to the client under a free slug, and both move the build to its client
// test the same way: the client and the copy recorded, the move and the test plan logged, what
// kept the trial from starting made an open item, and one line in the conversation.

import { readTestPlan } from "@countersign/core";
import { agent, build, type Tx } from "@countersign/db";
import { and, eq, like } from "drizzle-orm";
import { HttpError } from "../http";
import { addEvent, addItems, addMessage, type BuildRow } from "./store";

/** The template's slug in the client, or the first free `<slug>-2`, `-3`, … */
export async function freeSlug(tx: Tx, clientId: string, slug: string): Promise<string> {
  const taken = new Set(
    (
      await tx
        .select({ slug: agent.slug })
        .from(agent)
        .where(and(eq(agent.tenantId, clientId), like(agent.slug, `${slug}%`)))
    ).map((r) => r.slug),
  );
  if (!taken.has(slug)) return slug;
  for (let n = 2; n < 100; n++) if (!taken.has(`${slug}-${n}`)) return `${slug}-${n}`;
  throw new HttpError(409, "slug_taken", "the client has too many agents from this template");
}

/** What kept the client's copy from starting its trial, as the build's open item says it. */
export interface TrialBlock {
  title: string;
  detail: string;
}

/**
 * Moves a build (read and locked by the caller, in this transaction) to its client test at
 * `clientId`, with `testAgentId` the client's agent that runs. A build already there keeps its
 * phase and only takes the client and copy. `blocked` becomes an open item, made once per `key`.
 */
export async function moveToClientTest(
  tx: Tx,
  row: BuildRow,
  input: {
    clientId: string;
    testAgentId: string;
    userId: string;
    blocked: TrialBlock | null;
    /** The open item's key; `start:<copy>` when left empty. */
    key?: string;
  },
): Promise<void> {
  const { clientId, testAgentId, userId, blocked } = input;
  const from = row.phase;
  await tx
    .update(build)
    .set({
      ...(from === "client_test" ? {} : { phase: "client_test" as const, phaseAt: new Date() }),
      testClientId: clientId,
      testAgentId,
    })
    .where(eq(build.id, row.id));
  if (from !== "client_test") {
    await addEvent(tx, row, { kind: "phase", from, to: "client_test", userId });
    await addEvent(tx, row, {
      kind: "record",
      payload: { testPlan: readTestPlan(row.testPlan) },
      userId,
    });
  }
  const moved = { ...row, phase: "client_test" as const };
  if (blocked) {
    await addItems(
      tx,
      moved,
      [
        {
          phase: "client_test",
          kind: "precondition",
          title: blocked.title,
          detail: blocked.detail,
          key: input.key || `start:${testAgentId}`,
        },
      ],
      userId,
    );
  }
  await addMessage(tx, moved, {
    role: "builder",
    text: blocked
      ? "It's at the client, but its trial hasn't started: it needs one thing first, now an open item."
      : "It's published and at the client, in its trial: every write it makes waits for the client's signature until sign-off.",
  });
}
