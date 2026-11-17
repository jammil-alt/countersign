// The Dev queue's routes (docs/plan.md §1.125): the back office's Dev queue tab and the MCP tools
// call the same service (../dev-queue/service.ts), so every move has one set of guards. Reads run
// in the request's transaction; moves are slow routes (mountLong): the reuse check's judge and the
// notices' emails run outside any transaction.

import { codeRequestRoutes } from "@countersign/core";
import { build } from "@countersign/db";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import {
  acceptRequest,
  approveOneOff,
  attachPr,
  claimRequest,
  closeRequest,
  type DqCtx,
  fileRequest,
  linkToRequest,
  listRequests,
  noteRequest,
  rerunReuse,
  updateRequest,
} from "../dev-queue/service";
import { findRequest, requestDetail, stepRequests } from "../dev-queue/store";
import { type AppEnv, mount, mountLong } from "../http";

const now = () => new Date();

export function opsCodeRequestRoutes(app: Hono<AppEnv>): void {
  const dq = (ctx: {
    services: DqCtx["services"];
    inTx: DqCtx["inTx"];
    session: { user: { id: string } };
  }): DqCtx => ({
    services: ctx.services,
    inTx: ctx.inTx,
    userId: ctx.session.user.id,
    actor: "operator",
    now,
  });

  mount(app, codeRequestRoutes.opsCodeRequests, async ({ tx, query }) => listRequests(tx, query));

  mount(app, codeRequestRoutes.opsCodeRequest, async ({ tx, params, session }) =>
    requestDetail(tx, await findRequest(tx, params.id), now(), session.user.id),
  );

  mountLong(app, codeRequestRoutes.opsFileCodeRequest, async (ctx) =>
    fileRequest(
      {
        ...dq(ctx),
        actor: ctx.body.createdBy === "session" ? "session" : "operator",
      },
      ctx.body,
    ),
  );

  mountLong(app, codeRequestRoutes.opsUpdateCodeRequest, async (ctx) =>
    updateRequest(dq(ctx), ctx.params.id, ctx.body),
  );

  mountLong(app, codeRequestRoutes.opsCodeRequestReuse, async (ctx) =>
    rerunReuse(dq(ctx), ctx.params.id),
  );

  mountLong(app, codeRequestRoutes.opsAcceptCodeRequest, async (ctx) =>
    acceptRequest(dq(ctx), ctx.params.id),
  );

  mountLong(app, codeRequestRoutes.opsApproveOneOff, async (ctx) =>
    approveOneOff(dq(ctx), ctx.params.id),
  );

  mountLong(app, codeRequestRoutes.opsClaimCodeRequest, async (ctx) =>
    claimRequest(dq(ctx), ctx.params.id),
  );

  mountLong(app, codeRequestRoutes.opsCodeRequestPr, async (ctx) =>
    attachPr(dq(ctx), ctx.params.id, ctx.body.prUrl, ctx.body.expectedPartId),
  );

  mountLong(app, codeRequestRoutes.opsCloseCodeRequest, async (ctx) =>
    closeRequest(
      dq(ctx),
      ctx.params.id,
      ctx.body.reason,
      ctx.body.mergedInto ?? null,
      ctx.body.note ?? null,
    ),
  );

  mountLong(app, codeRequestRoutes.opsCodeRequestNote, async (ctx) =>
    noteRequest(dq(ctx), ctx.params.id, ctx.body.body),
  );

  mountLong(app, codeRequestRoutes.opsLinkCodeRequest, async (ctx) => {
    const { merge, ...link } = ctx.body;
    return linkToRequest(dq(ctx), ctx.params.id, link, merge);
  });

  // The Steps tab's "Requires code" (docs/plan.md §1.125): the agent's builds' steps waiting on a
  // request, with the request's status now.
  mount(app, codeRequestRoutes.opsAgentCodeRequests, async ({ tx, params }) => {
    const builds = await tx
      .select({ id: build.id })
      .from(build)
      .where(eq(build.agentId, params.id));
    return {
      steps: await stepRequests(
        tx,
        builds.map((b) => b.id),
      ),
    };
  });
}
