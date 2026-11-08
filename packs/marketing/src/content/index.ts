// The content area (M46; docs/plan.md §1.76): guides on a client's site (content_page,
// content_version, content_publish, content_redirect), the claims list (claims_version), the
// publish checks and the claims lint (pure, ./checks.ts and ./claims.ts), the tools an agent
// drafts with (`marketing.content.get`, `.draft`, `.check`), the `content`, `claims` and
// `content-preview` reports, and the people's actions of the back office's Content and Claims
// pages. Publishing itself is the `website` connector's `website.publish`, a change a person
// always signs (./publish.ts).
// Owned by the content builder (docs/marketing-plan.md §11).

import { type Db, withTenant } from "@countersign/db";
import { z } from "zod";
import {
  type AreaModule,
  defineAction,
  defineReport,
  type PackActionHandler,
  PackRefusal,
} from "../pack";
import { CONTENT_STATUSES } from "../schema";
import { listSites } from "../sites";
import { BODY_MAX, QUERIES_MAX, SLUG_MAX, SLUG_PATTERN } from "./checks";
import { ClaimsList } from "./claims";
import { publishGuide, type SigningContext, unpublishGuide } from "./publish";
import {
  addRedirect,
  addVersion,
  checkFor,
  claimsHistory,
  createPage,
  latestClaims,
  listPages,
  pageDetail,
  pageOf,
  pickSite,
  pointWebsite,
  redirectsOf,
  saveClaims,
  siteOf,
  versionOf,
  websiteConnection,
  websiteState,
} from "./store";
import { CONTENT_TOOLS } from "./tools";

export * from "./checks";
export * from "./claims";
export { renderMarkdown, textOf } from "./markdown";
export * from "./publish";
export { CONTENT_CHECK_TOOL, CONTENT_DRAFT_TOOL, CONTENT_GET_TOOL } from "./tools";

const cell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvOf = (rows: unknown[][]) => `${rows.map((r) => r.map(cell).join(",")).join("\n")}\n`;

// ── Reports ──────────────────────────────────────────────────────────────────────────────────────

export const ContentQuery = z.strictObject({
  site: z.uuid().optional(),
  status: z.enum(CONTENT_STATUSES).optional(),
});

async function contentReport(
  tx: Parameters<typeof listPages>[0],
  tenantId: string,
  query: z.output<typeof ContentQuery>,
) {
  const chosen = await pickSite(tx, tenantId, query.site);
  const sites = await listSites(tx, tenantId);
  const conn = await websiteConnection(tx, tenantId);
  if (!chosen) {
    return { site: null, sites, pages: [], redirects: [], website: websiteState(conn, null) };
  }
  const pages = await listPages(tx, tenantId, {
    siteId: chosen.id,
    ...(query.status ? { status: query.status } : {}),
  });
  return {
    site: { id: chosen.id, domain: chosen.domain, name: chosen.name },
    sites: sites.map((s) => ({ id: s.id, domain: s.domain, name: s.name })),
    pages,
    redirects: await redirectsOf(tx, tenantId, chosen.id),
    website: websiteState(conn, chosen.domain),
  };
}

/** What the platform's preview link renders: the fragment and its head, never anything else. */
export interface PreviewFragment {
  title: string;
  description: string;
  html: string;
  path: string;
  domain: string;
  version: number;
}

const REPORTS = {
  content: defineReport({
    title: "Content",
    query: ContentQuery,
    json: (tx, tenantId, _today, query) => contentReport(tx, tenantId, query),
    csv: async (tx, tenantId, _today, query) => {
      const r = await contentReport(tx, tenantId, query);
      return csvOf([
        ["path", "status", "title", "latest_version", "live_version", "updated_at", "published_at"],
        ...r.pages.map((p) => [
          p.path,
          p.status,
          p.title,
          p.latestVersion,
          p.liveVersion,
          p.updatedAt,
          p.lastPublishedAt,
        ]),
      ]);
    },
    item: (tx, tenantId, id) => pageDetail(tx, tenantId, id),
  }),
  claims: defineReport({
    title: "Claims",
    json: async (tx, tenantId) => ({
      latest: await latestClaims(tx, tenantId),
      versions: await claimsHistory(tx, tenantId),
    }),
    csv: async (tx, tenantId) => {
      const latest = await latestClaims(tx, tenantId);
      const list = latest?.list;
      return csvOf([
        ["kind", "id", "claim", "condition_or_why", "phrases"],
        ...(list?.approved ?? []).map((c) => ["approved", c.id, c.text, c.why ?? "", ""]),
        ...(list?.conditional ?? []).map((c) => [
          "conditional",
          c.id,
          c.text,
          c.condition,
          c.phrases.join("; "),
        ]),
        ...(list?.never ?? []).map((c) => [
          "never",
          c.id,
          c.text,
          c.why ?? "",
          c.phrases.join("; "),
        ]),
      ]);
    },
  }),
  // The platform's preview links (apps/api, `/api/preview/:token`) render a version through this
  // item: the checked, sanitised fragment with its title and description, and nothing else.
  "content-preview": defineReport({
    title: "Guide preview",
    json: async () => ({ about: "One version of a guide, as a preview link shows it." }),
    csv: async () => csvOf([["about"], ["One version of a guide, as a preview link shows it."]]),
    item: async (tx, tenantId, versionId): Promise<PreviewFragment | null> => {
      const version = await versionOf(tx, tenantId, versionId);
      if (!version) return null;
      const page = await pageOf(tx, tenantId, version.pageId);
      if (!page) return null;
      const target = await siteOf(tx, tenantId, page.siteId);
      if (!target) return null;
      const check = await checkFor(
        tx,
        tenantId,
        page.siteId,
        { title: version.title, description: version.description, body: version.bodyMd },
        page.path,
      );
      return {
        title: version.title,
        description: version.description,
        html: check.rendered.html,
        path: page.path,
        domain: target.domain,
        version: version.version,
      };
    },
  }),
};

// ── Actions ──────────────────────────────────────────────────────────────────────────────────────

const VersionFields = {
  title: z.string().max(200),
  description: z.string().max(500),
  body: z.string().max(BODY_MAX),
  targetQueries: z.array(z.string().trim().min(1).max(200)).max(QUERIES_MAX).default([]),
};

const CreatePageInput = z.strictObject({
  site: z.uuid(),
  slug: z.string().trim().regex(SLUG_PATTERN, "lowercase words joined by hyphens").max(SLUG_MAX),
  title: z.string().trim().max(200).default(""),
});
const SaveVersionInput = z.strictObject({
  page: z.uuid(),
  ...VersionFields,
  why: z.string().trim().max(1500).optional(),
});
const CheckInput = z.strictObject({
  page: z.uuid(),
  title: z.string().max(400),
  description: z.string().max(1000),
  body: z.string().max(BODY_MAX + 1000),
});
const PublishInput = z.strictObject({ page: z.uuid(), version: z.uuid().optional() });
const UnpublishInput = z.strictObject({ page: z.uuid() });
const PathInput = z
  .string()
  .trim()
  .regex(/^\/[^\s?#]*$/, "a path on the site, e.g. /guides/old-name")
  .max(512);
const RedirectInput = z.strictObject({ site: z.uuid(), from: PathInput, to: PathInput });
const SaveClaimsInput = z.strictObject({ list: ClaimsList });
const SetWebsiteInput = z.strictObject({ site: z.uuid() });

/**
 * An action that may sign a change outside: the platform's generic action context, plus the
 * `signedWrite` apps/api passes to every pack action (./publish.ts).
 */
function signingAction<I extends z.ZodType>(
  input: I,
  run: (db: Db, ctx: SigningContext<z.output<I>>) => Promise<Record<string, unknown>>,
): PackActionHandler {
  return {
    input,
    run: (db, ctx) => run(db, ctx as SigningContext<z.output<I>>),
  };
}

const ACTIONS: Record<string, PackActionHandler> = {
  "create-page": defineAction({
    input: CreatePageInput,
    run: (db, { tenantId, userId, input }) =>
      withTenant(db, tenantId, async (tx) => {
        const by = { kind: "person" as const, userId };
        const page = await createPage(tx, tenantId, { siteId: input.site, slug: input.slug }, by);
        const version = await addVersion(
          tx,
          tenantId,
          page.id,
          { title: input.title, description: "", body: "", targetQueries: [] },
          by,
        );
        return { pageId: page.id, path: page.path, versionId: version.id, version: 1 };
      }),
  }),
  "save-version": defineAction({
    input: SaveVersionInput,
    run: (db, { tenantId, userId, input }) =>
      withTenant(db, tenantId, async (tx) => {
        const version = await addVersion(
          tx,
          tenantId,
          input.page,
          {
            title: input.title,
            description: input.description,
            body: input.body,
            targetQueries: input.targetQueries,
            why: input.why ?? null,
          },
          { kind: "person", userId },
        );
        return { versionId: version.id, version: version.version };
      }),
  }),
  // The editor's live check of the words on screen, saved or not. Writes nothing.
  check: defineAction({
    input: CheckInput,
    run: (db, { tenantId, input }) =>
      withTenant(db, tenantId, async (tx) => {
        const page = await pageOf(tx, tenantId, input.page);
        if (!page) throw new PackRefusal("unknown_page", "That guide isn't one of this client's.");
        const check = await checkFor(tx, tenantId, page.siteId, input, page.path);
        return {
          html: check.rendered.html,
          headings: check.rendered.headings,
          problems: check.problems,
          words: check.words,
          publishable: check.publishable,
        };
      }),
  }),
  publish: signingAction(PublishInput, (db, ctx) =>
    publishGuide(db, {
      ...ctx,
      input: { pageId: ctx.input.page, versionId: ctx.input.version },
    }),
  ),
  unpublish: signingAction(UnpublishInput, (db, ctx) =>
    unpublishGuide(db, { ...ctx, input: { pageId: ctx.input.page } }),
  ),
  "add-redirect": defineAction({
    input: RedirectInput,
    run: (db, { tenantId, userId, input }) =>
      withTenant(db, tenantId, async (tx) => {
        await addRedirect(
          tx,
          tenantId,
          { siteId: input.site, from: input.from, to: input.to },
          userId,
        );
        return { redirects: await redirectsOf(tx, tenantId, input.site) };
      }),
  }),
  "save-claims": defineAction({
    input: SaveClaimsInput,
    run: (db, { tenantId, userId, input }) =>
      withTenant(db, tenantId, async (tx) => ({
        claims: await saveClaims(tx, tenantId, input.list, userId),
      })),
  }),
  // The first list of a client, from a JSON body (for Mezonas: fixtures/marketing/
  // mezonas-claims.json, from docs/marketing/claims.md). Refused once the client has one.
  "seed-claims": defineAction({
    input: SaveClaimsInput,
    run: (db, { tenantId, userId, input }) =>
      withTenant(db, tenantId, async (tx) => ({
        claims: await saveClaims(tx, tenantId, input.list, userId, { onlyIfNone: true }),
      })),
  }),
  "set-website": defineAction({
    input: SetWebsiteInput,
    run: (db, { tenantId, userId, input }) =>
      withTenant(db, tenantId, async (tx) => ({
        website: await pointWebsite(tx, tenantId, input.site, userId),
      })),
  }),
};

export const AREA: AreaModule = {
  TOOLS: CONTENT_TOOLS,
  SKILLS: [],
  TEMPLATES: [],
  EVENTS: [],
  SCREENS: [],
  REPORTS,
  ACTIONS,
};
