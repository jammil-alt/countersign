// Invite and Sign up now (docs/cases-plan.md §4.2, §4.3; docs/plan.md §1.125): one function both
// routes run. From the draft it makes the client (or uses the one there is) with the operator
// serving it, invites its people (§1.14's refusals first: an operator's address, someone in another
// client), adds the covered templates' agents on the bench with approvals on and a build each at
// Requirements request, opens the intake with the guide built from the file's `theirs` facts
// (core `buildGuide`), files the client file to the client and moves its documents, and moves the
// deal (a New account deal at Set up the account with the stages before it skipped, "signed up
// directly"; an Expansion deal at Agreed) or opens one. Client, people, agents, builds and intake
// are one transaction; the emails (`sendOnboardingEmail`) go after the commit. What a later stage
// wants and wasn't given becomes a to-do on Your call. Always a person's confirm (cases-plan §6):
// only the operator's routes call this, never Reggie or the MCP server.
//
// Stream SALES builds this (cases-plan O3); until then both functions throw.

import type { InviteDraft, InvitePreview, InviteSent, RouteSpec } from "@countersign/core";
import type { Hono } from "hono";
import type { AppEnv, LongHandlerCtx } from "../http";
import { notBuilt } from "./not-built";

/** Which route ran it: Invite's side panel, or Sign up now (a start's defaults, resolved to a draft). */
export type InviteVia = "invite" | "sign_up";

/** What the run needs from its route: the app (for `invokeRoute`) and the slow route's context. */
export interface InviteRun {
  app: Hono<AppEnv>;
  ctx: LongHandlerCtx<RouteSpec>;
  via: InviteVia;
  /** Sign up now: the start it came from (the draft's covers, note and mode are its own). */
  startId?: string;
}

/** What it will do, in the confirmation's words, and the emails and page as they'll be seen. */
// Stream SALES builds this.
export async function previewInvite(_run: InviteRun, _draft: InviteDraft): Promise<InvitePreview> {
  throw notBuilt("SALES", "previewInvite");
}

/** Does it: one transaction, then the emails. */
// Stream SALES builds this.
export async function runInvite(_run: InviteRun, _draft: InviteDraft): Promise<InviteSent> {
  throw notBuilt("SALES", "runInvite");
}
