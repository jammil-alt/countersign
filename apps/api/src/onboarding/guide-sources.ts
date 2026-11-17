// Where an intake's questions come from (docs/cases-plan.md §4.2 step 2; docs/plan.md §1.125): core's
// general section, each covered area's section (its pack's manifest, as data, else core's generic
// one) and each covered template's client intake form, read into core's `GuideSectionSource`. Invite
// and Sign up now (stream SALES) hand these with the file's `theirs` facts to core's `buildGuide`.
//
// Stream INTAKE builds this (it owns the sections and the readers); until then it throws.

import type { Covers, GuideSectionSource } from "@countersign/core";
import type { Tx } from "@countersign/db";
import type { Services } from "../http";
import { notBuilt } from "./not-built";

export interface GuideSources {
  general: GuideSectionSource | null;
  areas: GuideSectionSource[];
  agents: GuideSectionSource[];
}

/** The sections a covers asks, in covers' order. */
// Stream INTAKE builds this.
export async function guideSources(
  _tx: Tx,
  _services: Pick<Services, "platform">,
  _covers: Covers,
): Promise<GuideSources> {
  throw notBuilt("INTAKE", "guideSources");
}
