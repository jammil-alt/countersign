// An agent at its client (docs/plan.md §1.170): Turn on copies a template to the client under a
// free slug. The build's client test that shared this is gone (owner, 2026-11-27: a build goes
// from its draft to Publish; it is tried at the client in the agent's own go-live stages).

import { agent, type Tx } from "@countersign/db";
import { and, eq, like } from "drizzle-orm";
import { HttpError } from "../http";

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
