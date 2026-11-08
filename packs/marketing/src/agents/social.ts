// §1.77 (M49): social posts (docs/marketing-plan.md §4.6). A person asks for a post about a
// published guide or a weekly report; an agent writes it, `marketing.social.check` checks it in
// code, and it becomes one `linkedin.post` external action, which a person always signs
// (`approval: 'always'`) before it goes to the client's company page. The agent never posts. The
// checks: at most LinkedIn's 3,000 characters, the client's claims list and the house rules (no
// exclamation marks, never "AI-powered"), written from a guide that is live or a report of this
// client's, and no link but to the client's own site.

import { LINKEDIN_POST_MAX } from "@countersign/connectors";
import { withTenant } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { lintClaims } from "../content/claims";
import { latestClaims } from "../content/store";
import { mentionsDomain } from "../forum/rules";
import { defineTool, PackRefusal } from "../pack";
import { contentPage, marketingReport, site } from "../schema";
import { linksIn } from "./articles";

export const SOCIAL_CHECK_TOOL = "marketing.social.check";
/** A post shorter than this says too little to be worth a person's signature. */
export const SOCIAL_POST_MIN = 40;

export const SocialCheckInput = z
  .strictObject({
    /** The post, plain text, as it would appear. */
    text: z
      .string()
      .trim()
      .min(1)
      .max(LINKEDIN_POST_MAX * 2),
    /** What it is about: a guide that is live (`content_page` id), or a weekly report. */
    guide: z.uuid().nullish(),
    report: z.uuid().nullish(),
  })
  .refine((i) => Boolean(i.guide) !== Boolean(i.report), {
    message: "say what the post is about: a `guide` or a `report`, one of them",
  });

export const SocialCheckOutput = z.object({
  /** The post as it will be offered for signing. */
  text: z.string(),
  /** The guide's address on the site, when the post is about one. */
  link: z.string().nullable(),
  sources: z.array(z.string()),
});

/** What is wrong with a post's words, in plain words; empty when it may be offered. Pure. */
export function postProblems(
  text: string,
  rules: { domains: readonly string[]; claims?: Parameters<typeof lintClaims>[1] },
): string[] {
  const out: string[] = [];
  const t = text.trim();
  if (t.length > LINKEDIN_POST_MAX) {
    out.push(`The post is ${t.length} characters; LinkedIn takes at most ${LINKEDIN_POST_MAX}.`);
  }
  if (t.length < SOCIAL_POST_MIN) out.push("The post is too short to say anything.");
  for (const link of linksIn(t)) {
    if (!rules.domains.some((d) => mentionsDomain(link, d))) {
      out.push(`The post links to ${link}; a post links only to our own site.`);
    }
  }
  for (const f of lintClaims(t, rules.claims)) {
    if (f.severity === "refuse") out.push(`"${f.match}": ${f.message}`);
  }
  return [...new Set(out)];
}

export const socialCheckTool = defineTool({
  id: SOCIAL_CHECK_TOOL,
  description:
    "Check a LinkedIn post before it is offered to a person to sign: at most 3,000 characters, the client's claims list (no exclamation marks, never 'AI-powered'), about a guide that is live or one of the client's weekly reports, and no link but to the client's own site. Answers the post as it will be offered, or why it can't be.",
  sideEffect: "none",
  summary: "Checked a LinkedIn post",
  input: SocialCheckInput,
  output: SocialCheckOutput,
  run: (input, ctx) =>
    withTenant(ctx.db, ctx.tenantId, async (tx) => {
      const sites = await tx
        .select({ id: site.id, domain: site.domain })
        .from(site)
        .where(eq(site.tenantId, ctx.tenantId));
      let link: string | null = null;
      let sourceId: string;
      if (input.guide) {
        const [g] = await tx
          .select({
            id: contentPage.id,
            path: contentPage.path,
            status: contentPage.status,
            siteId: contentPage.siteId,
          })
          .from(contentPage)
          .where(and(eq(contentPage.id, input.guide), eq(contentPage.tenantId, ctx.tenantId)));
        if (!g) throw new PackRefusal("unknown_guide", "That guide isn't one of this client's.");
        if (g.status !== "published") {
          throw new PackRefusal(
            "not_live",
            "That guide isn't live; a post is written from a published guide.",
          );
        }
        const d = sites.find((s) => s.id === g.siteId)?.domain;
        link = d ? `https://${d}${g.path}` : null;
        sourceId = g.id;
      } else {
        const [r] = await tx
          .select({ id: marketingReport.id })
          .from(marketingReport)
          .where(
            and(
              eq(marketingReport.id, input.report as string),
              eq(marketingReport.tenantId, ctx.tenantId),
            ),
          );
        if (!r) throw new PackRefusal("unknown_report", "That report isn't one of this client's.");
        sourceId = r.id;
      }
      const claims = await latestClaims(tx, ctx.tenantId);
      const problems = postProblems(input.text, {
        domains: sites.map((s) => s.domain),
        ...(claims ? { claims: claims.list } : {}),
      });
      if (problems.length > 0) {
        throw new PackRefusal("post_refused", `The post can't be offered. ${problems.join(" ")}`);
      }
      return { text: input.text.trim(), link, sources: [sourceId] };
    }),
});
