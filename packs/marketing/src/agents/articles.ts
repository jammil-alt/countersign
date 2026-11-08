// §1.77: article drafts (docs/marketing-plan.md §4.6). An agent researches a topic (a person's, or
// one it picks from the site's search figures) with `web.search` and `web.fetch`, then drafts a
// guide for a person to read, check and publish. `marketing.article.draft` keeps the draft through
// the content area's `marketing.content.draft`, after checks in code:
// - It may cite only what its research found: every source and every outside link in the body
//   must be a page this run's `web.search` or `web.fetch` returned (read from the run's own tool
//   log, never from the model's word). Links to the client's own site are internal links, which
//   the content checks resolve.
// - The client's claims list and the house rules: a refused phrase refuses the draft.
// It never publishes: publishing is a person's signed act (docs/plan.md §1.76).

import { stepRun, type Tx, toolCall, withTenant } from "@countersign/db";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { DESCRIPTION_MAX, QUERIES_MAX, SLUG_MAX, SLUG_PATTERN, TITLE_MAX } from "../content/checks";
import { lintClaims } from "../content/claims";
import { latestClaims, pickSite } from "../content/store";
import { contentCheckTool, contentDraftTool } from "../content/tools";
import { defineTool, PackRefusal, type PackToolContext } from "../pack";

export const ARTICLE_DRAFT_TOOL = "marketing.article.draft";
/** The platform's research tools whose results an article may cite. */
export const RESEARCH_TOOLS = ["web.search", "web.fetch"] as const;

const Source = z.strictObject({
  title: z.string().trim().min(1).max(200),
  url: z.string().trim().min(1).max(500),
});

export const ArticleDraftInput = z
  .strictObject({
    /** A guide to add a version to; or a `slug` for a new guide on `site`. */
    page: z.uuid().optional(),
    site: z.uuid().optional(),
    slug: z.string().regex(SLUG_PATTERN).max(SLUG_MAX).optional(),
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
    /** The guide's Markdown body, no `#` heading (the title is the page's heading). */
    body: z.string().min(200).max(40_000),
    targetQueries: z.array(z.string().trim().min(1).max(200)).max(QUERIES_MAX).default([]),
    /** Why this guide: what it answers and what it was written from. */
    why: z.string().trim().min(1).max(800),
    /** The pages its research found that it rests on: only those. */
    sources: z.array(Source).min(1).max(20),
  })
  .refine((d) => Boolean(d.page) !== Boolean(d.slug), {
    message: "give either `page` (a new version) or `slug` (a new guide), not both",
  });
export type ArticleDraftInput = z.infer<typeof ArticleDraftInput>;

export const ArticleDraftOutput = z.object({
  /** False in a test run: checked, not kept. */
  recorded: z.boolean(),
  pageId: z.string().nullable(),
  path: z.string().nullable(),
  versionId: z.string().nullable(),
  version: z.number().int().nullable(),
  publishable: z.boolean(),
  problems: z.array(z.object({ code: z.string(), severity: z.string(), message: z.string() })),
  sources: z.array(z.string()),
});

/** A link as research and drafts compare it: no fragment, no trailing slash, host in lower case. */
export function linkKey(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.host.toLowerCase().replace(/^www\./, "")}${path}${u.search}`;
  } catch {
    return null;
  }
}

/** The outside links in a Markdown body: `[text](https://…)`, `<https://…>` and bare links. */
export function linksIn(markdown: string): string[] {
  const out = new Set<string>();
  for (const m of markdown.matchAll(/https?:\/\/[^\s<>()[\]"'`]+/g)) {
    out.add(m[0].replace(/[.,;:!?]+$/, ""));
  }
  return [...out];
}

/** What this run's research returned: every link `web.search` and `web.fetch` answered with. */
export async function researchFound(tx: Tx, tenantId: string, runId: string | null) {
  if (!runId) return new Set<string>();
  const rows = await tx
    .select({ output: toolCall.output })
    .from(toolCall)
    .innerJoin(
      stepRun,
      and(eq(stepRun.id, toolCall.stepRunId), eq(stepRun.tenantId, toolCall.tenantId)),
    )
    .where(
      and(
        eq(toolCall.tenantId, tenantId),
        eq(stepRun.runId, runId),
        inArray(toolCall.tool, [...RESEARCH_TOOLS]),
        eq(toolCall.status, "succeeded"),
      ),
    );
  const found = new Set<string>();
  const add = (u: unknown) => {
    if (typeof u !== "string") return;
    const k = linkKey(u);
    if (k) found.add(k);
  };
  for (const r of rows) {
    const o = r.output as {
      status?: unknown;
      sources?: unknown;
      results?: { url?: unknown }[];
      url?: unknown;
    } | null;
    if (!o || o.status !== "ok") continue;
    if (Array.isArray(o.sources)) o.sources.forEach(add);
    if (Array.isArray(o.results)) for (const x of o.results) add(x?.url);
    add(o.url);
  }
  return found;
}

/** Why a draft can't be kept, in plain words; empty when it can. Pure. */
export function citationProblems(
  draft: Pick<ArticleDraftInput, "sources" | "body">,
  found: ReadonlySet<string>,
  ownDomains: readonly string[],
): string[] {
  const out: string[] = [];
  const own = ownDomains.map((d) => d.toLowerCase().replace(/^www\./, ""));
  const isOwn = (key: string) =>
    own.some((d) => key === d || key.startsWith(`${d}/`) || key.startsWith(`${d}?`));
  if (found.size === 0) {
    out.push("Your research found nothing to cite: search and read first, or don't draft.");
  }
  for (const s of draft.sources) {
    const k = linkKey(s.url);
    if (!k) out.push(`The source ${s.url} isn't a web link.`);
    else if (!found.has(k)) out.push(`The source ${s.url} isn't a page your research found.`);
  }
  for (const link of linksIn(draft.body)) {
    const k = linkKey(link);
    if (!k) continue;
    if (!found.has(k) && !isOwn(k))
      out.push(`The body links to ${link}, which your research didn't find.`);
  }
  return [...new Set(out)];
}

async function ownDomains(tx: Tx, ctx: PackToolContext, site: string | undefined) {
  const chosen = await pickSite(tx, ctx.tenantId, site);
  return chosen ? [chosen.domain] : [];
}

export const articleDraftTool = defineTool({
  id: ARTICLE_DRAFT_TOOL,
  description:
    "Save your article as a draft guide for a person to read, check and publish; you never publish. A new guide at /guides/<slug> (`slug`) or a new version of one (`page`). Cite only pages your research in this run found with web.search or web.fetch (their exact links), and link to nothing else outside the site. Its words must pass the client's claims list (no exclamation marks, never 'AI-powered'). If it is refused, the answer says why: fix the draft and call again.",
  sideEffect: "internal",
  summary: "Drafted a guide for a person to read",
  input: ArticleDraftInput,
  output: ArticleDraftOutput,
  async run(input, ctx) {
    const problems = await withTenant(ctx.db, ctx.tenantId, async (tx) => {
      const found = await researchFound(tx, ctx.tenantId, ctx.runId);
      const out = citationProblems(input, found, await ownDomains(tx, ctx, input.site));
      const claims = await latestClaims(tx, ctx.tenantId);
      for (const f of lintClaims(
        `${input.title}\n${input.description}\n${input.body}`,
        claims?.list,
      )) {
        if (f.severity === "refuse") out.push(`"${f.match}": ${f.message}`);
      }
      return out;
    });
    if (problems.length > 0) {
      throw new PackRefusal("draft_refused", `The draft wasn't kept. ${problems.join(" ")}`);
    }
    const urls = input.sources.map((s) => s.url);
    if (ctx.mode === "test") {
      // A test run checks and keeps nothing.
      const check = (await contentCheckTool.run(
        {
          ...(input.site ? { site: input.site } : {}),
          ...(input.slug ? { slug: input.slug } : {}),
          title: input.title,
          description: input.description,
          body: input.body,
        },
        ctx,
      )) as {
        publishable: boolean;
        problems: { code: string; severity: string; message: string }[];
      };
      return {
        recorded: false,
        pageId: input.page ?? null,
        path: input.slug ? `/guides/${input.slug}` : null,
        versionId: null,
        version: null,
        publishable: check.publishable,
        problems: check.problems.map((p) => ({
          code: p.code,
          severity: p.severity,
          message: p.message,
        })),
        sources: urls,
      };
    }
    const saved = (await contentDraftTool.run(
      {
        ...(input.page ? { page: input.page } : {}),
        ...(input.site ? { site: input.site } : {}),
        ...(input.slug ? { slug: input.slug } : {}),
        title: input.title,
        description: input.description,
        body: input.body,
        targetQueries: input.targetQueries,
        why: input.why,
        sources: input.sources.map((s) => `${s.title}: ${s.url}`.slice(0, 300)),
      },
      ctx,
    )) as {
      pageId: string;
      path: string;
      versionId: string;
      version: number;
      check: {
        publishable: boolean;
        problems: { code: string; severity: string; message: string }[];
      };
    };
    return {
      recorded: true,
      pageId: saved.pageId,
      path: saved.path,
      versionId: saved.versionId,
      version: saved.version,
      publishable: saved.check.publishable,
      problems: saved.check.problems.map((p) => ({
        code: p.code,
        severity: p.severity,
        message: p.message,
      })),
      sources: [saved.pageId, saved.versionId, ...urls],
    };
  },
});
