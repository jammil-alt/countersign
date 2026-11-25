// Request an action (docs/step-model-plan.md §10c): what somebody needs, in their own words, becomes
// a Dev queue request with the reuse check, from a connector's page, an agent's, or a client's
// account. Whoever asks only describes the need; the Dev queue's own filing (`fileRequest`) judges it
// against what exists, so a request for something we already have comes back as "exists" or as a
// duplicate, never a second request.
//
// A client's request is filed with the client's words held to its HIPAA mode (the reuse check's
// judge refuses a call it may not make, and the candidates come back unjudged), and the client is
// told only that we have it: no request number, no word of connectors or the queue.

import type { ActionRequestAnswer, NewActionRequest } from "@countersign/core";
import { agent, tenant, withOperator } from "@countersign/db";
import { eq } from "drizzle-orm";
import type { Services } from "../http";
import { type DqCtx, fileRequest } from "./service";

export interface Asker {
  userId: string;
  /** Who is asking: the back office, or a client from their own account. */
  from: "operator" | "client";
  /** The client the need is for. */
  clientId?: string | undefined;
}

const TITLE_MAX = 120;

/** The need's first sentence, for the request's title. */
function titleOf(what: string): string {
  const first = (what.split(/(?<=[.!?])\s|\n/)[0] ?? what).trim();
  const text = first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 1)}…` : first;
  return `Action asked for: ${text}`;
}

/** An operator-scoped transaction for the Dev queue, whoever is asking (its tables are operator's). */
function operatorTx(services: Services): DqCtx["inTx"] {
  return (work) =>
    withOperator(services.db, [], (tx) =>
      work({
        role: "operator",
        tenantIds: [],
        operator: true,
        tx,
        afterCommit: () => undefined,
        defer: () => undefined,
      }),
    );
}

/**
 * Files the need. `ctx` is the caller's Dev queue context (the back office's own), or none for a
 * client, whose request is filed in an operator-scoped transaction of its own.
 */
export async function requestAction(
  services: Services,
  asker: Asker,
  input: Pick<NewActionRequest, "what" | "connector" | "agentId">,
  ctx?: DqCtx,
): Promise<ActionRequestAnswer> {
  const dq: DqCtx = ctx ?? {
    services,
    inTx: operatorTx(services),
    userId: asker.userId,
    actor: "operator",
    now: () => new Date(),
  };
  // Who it is for and where it was asked, read in an operator-scoped transaction of its own.
  const facts = await withOperator(services.db, [], async (tx) => {
    const [a] = input.agentId
      ? await tx
          .select({ name: agent.name, tenantId: agent.tenantId })
          .from(agent)
          .where(eq(agent.id, input.agentId))
      : [];
    const clientId = a?.tenantId ?? asker.clientId;
    const [t] = clientId
      ? await tx.select({ name: tenant.name }).from(tenant).where(eq(tenant.id, clientId))
      : [];
    return { clientId, client: t?.name ?? null, agent: a?.name ?? null };
  });
  const where = [
    asker.from === "client" ? "asked from the client's account" : null,
    input.connector ? `from the ${input.connector} connector's page` : null,
    facts.agent ? `from the agent ${facts.agent}` : null,
    facts.client ? `for ${facts.client}` : null,
  ].filter((x): x is string => x !== null);
  const summary = `${input.what}\n\nAsked ${where.length > 0 ? where.join(", ") : "from the back office"}.`;
  const filed = await fileRequest(
    {
      ...dq,
      ...(facts.clientId ? { clients: [facts.clientId] } : {}),
    },
    {
      title: titleOf(input.what),
      // DECISION: a new action is a new tool until triage says it is config or an extension; the
      // reuse check proposes `exists` itself when a part already does it.
      kind: "new_tool",
      spec: {
        summary,
        inputs: [],
        outputs: [],
        rules: [],
        acceptance: [],
        parts: input.connector ? [input.connector] : [],
        packages: [],
      },
      openQuestions: [],
      otherUses: [],
      considered: [],
      createdBy: "operator",
    },
  );
  return {
    ref: filed.request?.ref ?? null,
    duplicate: filed.duplicate ? { ref: filed.duplicate.ref, title: filed.duplicate.title } : null,
  };
}
