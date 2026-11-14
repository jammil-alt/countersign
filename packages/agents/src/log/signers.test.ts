// Wave 2c (docs/plan.md §1.86): a change more than one person signs, against a real database as
// cs_worker and the testkit connector. Edits are refused once a change has more than one approval
// item, whichever item the edit comes through; a change approved by a signer's yes is never claimed
// inside that signer's undo window; a change a person edited never goes ahead on a deadline.

import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import { agent, externalAction, inboxItem, withTenant } from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentsError } from "../errors";
import { createTemplate, fork, publish, updateOperational } from "../registry/agents";
import { unsignedRefusal } from "../runtime/actions";
import { callTool } from "../runtime/call-tool";
import type { StepContext } from "../runtime/context";
import type { PinnedAgent } from "../runtime/ports";
import {
  addSignerItemTx,
  proposedActionTx,
  recordEditTx,
  resolveExternalAction,
} from "./external-actions";
import { createHarness, type Harness, makeBundle } from "./harness.test-helper";
import { createRun } from "./run-log";

const harness = await createHarness();
afterAll(() => harness?.close());

describe.skipIf(!harness)("a change more than one person signs", () => {
  const h = harness as Harness;
  let agentId = "";
  let versionId = "";

  beforeAll(async () => {
    const tv = await h.ops(async (tx) => {
      const { agent: tpl, version } = await createTemplate(tx, {
        slug: "signers",
        bundle: makeBundle({ mode: "act" }),
      });
      return publish(tx, { agentId: tpl.id, versionId: version.id, ctx: h.ctx });
    });
    const a = await h.ops(async (tx) => {
      const forked = await fork(tx, {
        tenantId: h.A.tenantId,
        slug: "signers",
        templateVersionId: tv.id,
      });
      await updateOperational(tx, {
        agentId: forked.agent.id,
        patch: { bindings: { testkit: h.A.connectionId } },
      });
      await publish(tx, { agentId: forked.agent.id, versionId: forked.version.id, ctx: h.ctx });
      await tx
        .update(agent)
        .set({ runStatus: "active", stage: "live" })
        .where(eq(agent.id, forked.agent.id));
      return { agentId: forked.agent.id, versionId: forked.version.id };
    });
    agentId = a.agentId;
    versionId = a.versionId;
  });

  /** A write proposed for approval on a new live run, in act mode. */
  async function propose(amount: string) {
    const deps = h.deps();
    const pinned: PinnedAgent = await deps.ports.store.loadAgentVersion(h.A.tenantId, versionId);
    const r = await h.client(h.A, (tx) =>
      createRun(tx, {
        tenantId: h.A.tenantId,
        agentId,
        workflowSlug: "check-record",
        mode: "live",
      }),
    );
    const stepRunId = await deps.ports.log.startStepRun(h.A.tenantId, {
      runId: r.id,
      nodeId: "update",
      nodeType: "action",
      skillRef: null,
      agentVersionId: versionId,
      input: {},
    });
    const ctx: StepContext = {
      tenantId: h.A.tenantId,
      agent: pinned,
      runId: r.id,
      stepRunId,
      stepId: "update",
      mode: "live",
      approval: { required: "required", onReject: "stop" },
      externalIndex: { next: 0 },
    };
    const out = await callTool(deps, ctx, {
      toolId: TESTKIT_UPDATE_TOOL,
      input: { id: "r1", amount },
    });
    if (out.status !== "awaiting_approval" || !out.inboxItemId) throw new Error(out.status);
    return { runId: r.id, actionId: out.actionId, gateItem: out.inboxItemId };
  }

  /** One more signer, the client user, beside the gate's card (the client admin's). */
  const askUser = (p: { runId: string; actionId: string }) =>
    withTenant(h.db, h.A.tenantId, (tx) =>
      addSignerItemTx(tx, h.A.tenantId, {
        actionId: p.actionId,
        runId: p.runId,
        nodeId: "update:approver:1",
        assigneeRole: null,
        assigneeUserId: h.A.userId,
        dueAt: new Date(Date.now() + 86_400_000),
      }),
    );

  const approve = (inboxItemId: string, userId: string, role: "client_admin" | "client_user") =>
    resolveExternalAction(h.db, {
      tenantId: h.A.tenantId,
      inboxItemId,
      decision: "approve",
      by: { userId, role },
    });

  it("refuses an edit through any of its cards once two people sign it", async () => {
    const p = await propose("21.00");
    // One signer: the gate's card may be edited.
    await withTenant(h.db, h.A.tenantId, (tx) => proposedActionTx(tx, h.A.tenantId, p.gateItem));
    const signer = await askUser(p);
    // The user says yes first; the admin's card is still open.
    await approve(signer.id, h.A.userId, "client_user");
    for (const item of [p.gateItem, signer.id]) {
      const viaCheck = await withTenant(h.db, h.A.tenantId, (tx) =>
        proposedActionTx(tx, h.A.tenantId, item),
      ).catch((e: AgentsError) => e);
      expect(viaCheck).toMatchObject({ code: "invalid_state" });
      expect(String((viaCheck as Error).message)).toMatch(/others are signing this change/);
      const viaRecord = await withTenant(h.db, h.A.tenantId, (tx) =>
        recordEditTx(tx, {
          tenantId: h.A.tenantId,
          inboxItemId: item,
          edited: { id: "r1", amount: "99.00" },
          by: h.A.adminId,
          at: new Date(),
        }),
      ).catch((e: AgentsError) => e);
      expect(String((viaRecord as Error).message)).toMatch(/others are signing this change/);
    }
    const [action] = await h.client(h.A, (tx) =>
      tx.select().from(externalAction).where(eq(externalAction.id, p.actionId)),
    );
    expect(action).toMatchObject({ status: "proposed", editedInput: null });
  });

  it("is never claimed inside the undo window of the signer whose yes approved it", async () => {
    const p = await propose("22.00");
    const signer = await askUser(p);
    await approve(p.gateItem, h.A.adminId, "client_admin");
    await approve(signer.id, h.A.userId, "client_user");
    // The user's yes was the last: it approved the change, and it is held for its undo window.
    await h.client(h.A, (tx) =>
      tx
        .update(inboxItem)
        .set({ deliverAfter: new Date(Date.now() + 3_600_000) })
        .where(eq(inboxItem.id, signer.id)),
    );
    const claimed = await h.deps().ports.actions.claim(h.A.tenantId, p.actionId);
    expect(claimed.claimed).toBe(false);
    expect(claimed.action.status).toBe("approved");
    // Once the window has passed, it is the run's.
    await h.client(h.A, (tx) =>
      tx.update(inboxItem).set({ deliverAfter: null }).where(eq(inboxItem.id, signer.id)),
    );
    expect((await h.deps().ports.actions.claim(h.A.tenantId, p.actionId)).claimed).toBe(true);
  });

  it("never lets a change a person edited go ahead with nobody's signature", async () => {
    await h.setPermissions(h.A, { update: "auto" });
    try {
      const p = await propose("23.00");
      const ask = () => unsignedRefusal(h.deps(), { tenantId: h.A.tenantId, actionId: p.actionId });
      // As the agent proposed it: the gate would let it run unsigned.
      expect(await ask()).toBeNull();
      // The admin edits it and never signs.
      await h.client(h.A, (tx) =>
        tx
          .update(externalAction)
          .set({
            editedInput: { id: "r1", amount: "230.00" },
            editedBy: h.A.adminId,
            editedAt: new Date(),
          })
          .where(eq(externalAction.id, p.actionId)),
      );
      expect(await ask()).toMatch(/edited this change and never signed it/);
    } finally {
      await h.setPermissions(h.A, { update: "approval" });
    }
  });
});
