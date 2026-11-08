// §1.77: titles and descriptions (docs/marketing-plan.md §4.6). Each week an agent reads the
// site's search figures, picks pages people see in search but seldom click (impressions and a
// low click-through rate) and proposes a better title and description for some of them. The
// proposals are checked in code (`marketing.titles.check`, this file) before any is offered: the
// page must be one of the site's, the title at most 60 characters and the description at most
// 155, the words must pass the client's claims list, a page already waiting for a person gets no
// second proposal, and no more than `max_per_day` a day. Each that passes becomes a
// `website.meta` external action with the wording now and proposed, which a person always signs
// (`approval: 'always'`): the agent never changes a page itself.

import { WEBSITE_META_TOOL } from "@countersign/connectors";
import { externalAction, type Tx, withTenant } from "@countersign/db";
import { and, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { DESCRIPTION_MAX, slugOf, TITLE_MAX } from "../content/checks";
import { lintClaims } from "../content/claims";
import { latestClaims, pickSite } from "../content/store";
import { defineTool, PackRefusal } from "../pack";
import { contentPage, contentVersion } from "../schema";

export const TITLES_CHECK_TOOL = "marketing.titles.check";
/** The default for at most this many proposals a day, per client. */
export const TITLES_PER_DAY = 3;
/** The most a setting may raise it to. */
export const TITLES_PER_DAY_MAX = 10;

const Path = z
  .string()
  .trim()
  .regex(/^\/[^\s]{0,511}$/, "a page's path, starting with /")
  .max(512);

export const TitleProposal = z.strictObject({
  path: Path,
  title: z
    .string()
    .trim()
    .min(1)
    .max(TITLE_MAX * 2),
  description: z
    .string()
    .trim()
    .min(1)
    .max(DESCRIPTION_MAX * 2),
  /** Why: the page's search figures and what the new words answer. */
  why: z.string().trim().min(1).max(500),
  /** The search queries it was written for. */
  queries: z.array(z.string().trim().min(1).max(200)).max(5).default([]),
});
export type TitleProposal = z.infer<typeof TitleProposal>;

export const TitlesCheckInput = z.strictObject({
  site: z.uuid().optional(),
  proposals: z.array(TitleProposal).max(10),
});

const Wording = z.object({ title: z.string(), description: z.string() });

export const TitlesCheckOutput = z.object({
  /** The proposals that may be offered, each to become one `website.meta` a person signs. */
  proposals: z.array(
    z.object({
      path: z.string(),
      title: z.string(),
      description: z.string(),
      why: z.string(),
      queries: z.array(z.string()),
      /** The wording now, when we keep it (a guide); a page of the site's own is read at signing. */
      now: Wording.nullable(),
      search: z
        .object({
          impressions: z.number().int(),
          clicks: z.number().int(),
          ctr: z.string().nullable(),
        })
        .nullable(),
    }),
  ),
  /** The ones refused, with why in plain words. */
  refused: z.array(z.object({ path: z.string(), reasons: z.array(z.string()) })),
  /** Left out because today's limit was reached. */
  overLimit: z.number().int(),
  limit: z.number().int(),
  sources: z.array(z.string()),
});

/** The limit a skill's settings ask for, within bounds. */
export function perDayLimit(settings: Readonly<Record<string, unknown>>): number {
  const v = settings.max_per_day;
  if (typeof v === "number" && Number.isInteger(v) && v >= 0)
    return Math.min(v, TITLES_PER_DAY_MAX);
  return TITLES_PER_DAY;
}

/** What is wrong with one proposal's words, in plain words; empty when it may be offered. Pure. */
export function wordingProblems(
  p: Pick<TitleProposal, "title" | "description">,
  claims?: Parameters<typeof lintClaims>[1],
): string[] {
  const out: string[] = [];
  if (p.title.length > TITLE_MAX) {
    out.push(`The title is ${p.title.length} characters; at most ${TITLE_MAX}.`);
  }
  if (p.description.length > DESCRIPTION_MAX) {
    out.push(`The description is ${p.description.length} characters; at most ${DESCRIPTION_MAX}.`);
  }
  if (p.title.length < 10) out.push("The title is too short to say what the page is.");
  if (p.description.length < 50) out.push("The description is too short; aim for 120 to 155.");
  for (const f of lintClaims(`${p.title}\n${p.description}`, claims)) {
    if (f.severity === "refuse") out.push(`"${f.match}": ${f.message}`);
  }
  return out;
}

const utcMidnight = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/** How many `website.meta` changes were proposed for this client since midnight (UTC). */
// DECISION (§1.77): "a day" is the UTC day, and every proposal counts (signed, waiting, turned
// down), so a rejected one doesn't free a place the same day.
export async function proposedToday(tx: Tx, tenantId: string, now: Date): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(externalAction)
    .where(
      and(
        eq(externalAction.tenantId, tenantId),
        eq(externalAction.tool, WEBSITE_META_TOOL),
        gte(externalAction.createdAt, utcMidnight(now)),
      ),
    );
  return Number(row?.n ?? 0);
}

/** Paths with a `website.meta` change still waiting for a person. */
async function waitingPaths(tx: Tx, tenantId: string): Promise<Set<string>> {
  const rows = await tx
    .select({ input: externalAction.input })
    .from(externalAction)
    .where(
      and(
        eq(externalAction.tenantId, tenantId),
        eq(externalAction.tool, WEBSITE_META_TOOL),
        inArray(externalAction.status, ["proposed", "approved", "executing"]),
      ),
    );
  return new Set(
    rows
      .map((r) => (r.input as { path?: unknown } | null)?.path)
      .filter((p): p is string => typeof p === "string"),
  );
}

export const titlesCheckTool = defineTool({
  id: TITLES_CHECK_TOOL,
  description:
    "Check proposed titles and descriptions before they are offered to a person: each page must be one of the site's (seen in search or a guide), a title at most 60 characters and a description at most 155, the words must pass the client's claims list (no exclamation marks, never 'AI-powered'), a page already waiting for a person gets no second proposal, and at most the day's limit. Answers the proposals that pass, with the wording now where we keep it, and the refused ones with why.",
  sideEffect: "none",
  summary: "Checked {{proposals.length}} title proposals",
  input: TitlesCheckInput,
  output: TitlesCheckOutput,
  run: (input, ctx) =>
    withTenant(ctx.db, ctx.tenantId, async (tx) => {
      const chosen = await pickSite(tx, ctx.tenantId, input.site);
      if (!chosen) throw new PackRefusal("no_site", "This client has no site yet.");
      const claims = await latestClaims(tx, ctx.tenantId);
      const limit = perDayLimit(ctx.settings);
      const today = await proposedToday(tx, ctx.tenantId, new Date());
      const waiting = await waitingPaths(tx, ctx.tenantId);
      const paths = [...new Set(input.proposals.map((p) => p.path))];
      // The site's pages in search over the last 90 days, with their figures.
      const searched = paths.length
        ? await tx.execute<{ path: string; impressions: number; clicks: number }>(sql`
            select path, sum(impressions)::int as impressions, sum(clicks)::int as clicks
            from search_page_daily
            where tenant_id = ${ctx.tenantId} and site_id = ${chosen.id}
              and day >= (current_date - 90)
              and path in (${sql.join(
                paths.map((p) => sql`${p}`),
                sql`, `,
              )})
            group by path`)
        : [];
      const bySearch = new Map([...searched].map((r) => [r.path, r]));
      const guides = paths.length
        ? await tx
            .select({ id: contentPage.id, path: contentPage.path, live: contentPage.liveVersionId })
            .from(contentPage)
            .where(
              and(
                eq(contentPage.tenantId, ctx.tenantId),
                eq(contentPage.siteId, chosen.id),
                inArray(contentPage.path, paths),
                ne(contentPage.status, "draft"),
              ),
            )
        : [];
      const liveIds = guides.map((g) => g.live).filter((v): v is string => v !== null);
      const live = liveIds.length
        ? await tx
            .select({
              id: contentVersion.id,
              title: contentVersion.title,
              description: contentVersion.description,
            })
            .from(contentVersion)
            .where(
              and(eq(contentVersion.tenantId, ctx.tenantId), inArray(contentVersion.id, liveIds)),
            )
        : [];
      const out: z.input<typeof TitlesCheckOutput>["proposals"] = [];
      const refused: { path: string; reasons: string[] }[] = [];
      let overLimit = 0;
      const seen = new Set<string>();
      for (const p of input.proposals) {
        const reasons: string[] = [];
        const s = bySearch.get(p.path);
        const guide = guides.find((g) => g.path === p.path);
        const isGuide = slugOf(p.path) !== null && guide !== undefined;
        if (!s && !isGuide)
          reasons.push("This page isn't one the site's search figures or guides know.");
        if (seen.has(p.path)) reasons.push("A proposal for this page is already in this batch.");
        if (waiting.has(p.path))
          reasons.push("A change to this page is already waiting for a person.");
        reasons.push(...wordingProblems(p, claims?.list));
        const nowWords = guide?.live ? live.find((v) => v.id === guide.live) : undefined;
        if (nowWords && nowWords.title === p.title && nowWords.description === p.description) {
          reasons.push("This is the wording the page has now.");
        }
        if (reasons.length > 0) {
          refused.push({ path: p.path, reasons });
          continue;
        }
        seen.add(p.path);
        if (today + out.length >= limit) {
          overLimit += 1;
          continue;
        }
        out.push({
          path: p.path,
          title: p.title,
          description: p.description,
          why: p.why,
          queries: p.queries,
          now: nowWords ? { title: nowWords.title, description: nowWords.description } : null,
          search: s
            ? {
                impressions: Number(s.impressions),
                clicks: Number(s.clicks),
                ctr:
                  Number(s.impressions) > 0
                    ? (Number(s.clicks) / Number(s.impressions)).toFixed(4)
                    : null,
              }
            : null,
        });
      }
      return {
        proposals: out,
        refused,
        overLimit,
        limit,
        sources: [chosen.id, ...guides.map((g) => g.id)],
      };
    }),
});
