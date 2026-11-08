// Publishing and unpublishing a guide (docs/marketing-plan.md §4.5, §11.4): a person's action in
// the back office, signed by that person as they make it, that goes through the `website`
// connector's `website.publish` as one external action (executed once, by its idempotency key,
// with its before state). The pack never writes the site itself (invariant 8): the platform hands
// the action a `signedWrite` (apps/api/src/signed-writes.ts), which records the external action
// as approved by the person and runs it through the connector. Only once it is done does the pack
// record the publish and the page's live version.
//
// Nothing public changes on merge: without the SITE_CONTENT binding the connector refuses
// ("publishing isn't set up"), the external action is recorded as failed, and the page stays as
// it was (docs/marketing-plan.md §11.5).

import { type Db, withTenant } from "@countersign/db";
import { PackRefusal } from "../pack";
import { slugOf } from "./checks";
import {
  checkFor,
  latestVersion,
  pageOf,
  publishCount,
  recordPublish,
  redirectsOf,
  siteOf,
  versionOf,
  websiteConnection,
} from "./store";

/** The connector tool publishing goes through: a change a person always signs (§1.73). */
export const PUBLISH_TOOL = "website.publish";

export interface SignedWriteRequest {
  connectionId: string;
  /** A connector's external tool, e.g. `website.publish`. */
  tool: string;
  input: Record<string, unknown>;
  /** The external action's key: the same key never writes twice. */
  idempotencyKey: string;
  /** What the person is signing, in a line (the external action's record). */
  title: string;
}

export type SignedWriteOutcome =
  | { status: "done"; actionId: string; output: unknown }
  | { status: "failed"; actionId: string | null; error: string };

/**
 * A change outside, signed by the person taking the action: the platform records it as an
 * external action they approved and runs it once through its connector.
 */
export type SignedWrite = (request: SignedWriteRequest) => Promise<SignedWriteOutcome>;

/** What a content action is given: the platform's generic one, plus `signedWrite` where offered. */
export interface SigningContext<I> {
  tenantId: string;
  userId: string;
  input: I;
  signedWrite?: SignedWrite;
}

/** The connector's error, without its class name: "WebsiteSetupError: x" → "x". */
export function reasonOf(error: string): string {
  return error.replace(/^[A-Za-z]*Error:\s*/, "").trim() || "the change failed";
}

async function prepare(db: Db, tenantId: string, pageId: string) {
  return withTenant(db, tenantId, async (tx) => {
    const page = await pageOf(tx, tenantId, pageId);
    if (!page) throw new PackRefusal("unknown_page", "That guide isn't one of this client's.");
    const target = await siteOf(tx, tenantId, page.siteId);
    if (!target) throw new PackRefusal("unknown_site", "The guide's site is missing.");
    const slug = slugOf(page.path);
    if (!slug) throw new PackRefusal("not_a_guide", "Only guides are published from here.");
    const conn = await websiteConnection(tx, tenantId);
    if (!conn || conn.status === "disconnected") {
      throw new PackRefusal(
        "no_website_connection",
        "This client has no Website connection: add it, then point it at the site.",
      );
    }
    if (conn.domain !== target.domain) {
      throw new PackRefusal(
        "website_elsewhere",
        `The Website connection publishes to ${conn.domain ?? "no site yet"}, not ${target.domain}. Point it at this site first.`,
      );
    }
    const redirects = await redirectsOf(tx, tenantId, page.siteId);
    const n = await publishCount(tx, tenantId, page.id);
    return { page, target, slug, conn, redirects, n };
  });
}

/** Publishes one version of a guide (its newest by default), once its checks pass. */
export async function publishGuide(
  db: Db,
  ctx: SigningContext<{ pageId: string; versionId?: string | undefined }>,
) {
  const { tenantId, userId } = ctx;
  const { page, target, slug, conn, redirects, n } = await prepare(db, tenantId, ctx.input.pageId);
  const { version, check } = await withTenant(db, tenantId, async (tx) => {
    const version = ctx.input.versionId
      ? await versionOf(tx, tenantId, ctx.input.versionId)
      : await latestVersion(tx, tenantId, page.id);
    if (!version || version.pageId !== page.id) {
      throw new PackRefusal("unknown_version", "That version isn't one of this guide's.");
    }
    const check = await checkFor(
      tx,
      tenantId,
      page.siteId,
      { title: version.title, description: version.description, body: version.bodyMd },
      page.path,
    );
    return { version, check };
  });
  const refused = check.problems.filter((p) => p.severity === "refuse");
  if (refused.length > 0) {
    const more = refused.length > 1 ? ` (and ${refused.length - 1} more)` : "";
    throw new PackRefusal("checks_refused", `Not published: ${refused[0]?.message}${more}`);
  }
  if (!ctx.signedWrite) {
    throw new PackRefusal("not_available", "Publishing isn't available here.");
  }
  const outcome = await ctx.signedWrite({
    connectionId: conn.id,
    tool: PUBLISH_TOOL,
    input: {
      action: "publish",
      slug,
      title: version.title,
      description: version.description,
      html: check.rendered.html,
      redirects,
    },
    idempotencyKey: `marketing:publish:${page.id}:${version.id}:${n}`,
    title: `Publish ${page.path} (version ${version.version}) on ${target.domain}`,
  });
  if (outcome.status !== "done") {
    throw new PackRefusal("not_published", `Not published: ${reasonOf(outcome.error)}.`);
  }
  await withTenant(db, tenantId, (tx) =>
    recordPublish(tx, tenantId, {
      pageId: page.id,
      versionId: version.id,
      action: "publish",
      externalActionId: outcome.actionId,
      userId,
    }),
  );
  return {
    status: "published",
    path: page.path,
    url: `https://${target.domain}${page.path}`,
    version: version.version,
    externalActionId: outcome.actionId,
  };
}

/** Takes a live guide down: its page and sitemap entry go; its versions stay. */
export async function unpublishGuide(db: Db, ctx: SigningContext<{ pageId: string }>) {
  const { tenantId, userId } = ctx;
  const { page, target, slug, conn, redirects, n } = await prepare(db, tenantId, ctx.input.pageId);
  if (page.status !== "published" || !page.liveVersionId) {
    throw new PackRefusal("not_live", "This guide isn't live.");
  }
  if (!ctx.signedWrite) {
    throw new PackRefusal("not_available", "Unpublishing isn't available here.");
  }
  const outcome = await ctx.signedWrite({
    connectionId: conn.id,
    tool: PUBLISH_TOOL,
    input: { action: "unpublish", slug, redirects },
    idempotencyKey: `marketing:unpublish:${page.id}:${n}`,
    title: `Unpublish ${page.path} on ${target.domain}`,
  });
  if (outcome.status !== "done") {
    throw new PackRefusal("not_unpublished", `Not unpublished: ${reasonOf(outcome.error)}.`);
  }
  const liveVersionId = page.liveVersionId;
  await withTenant(db, tenantId, (tx) =>
    recordPublish(tx, tenantId, {
      pageId: page.id,
      versionId: liveVersionId,
      action: "unpublish",
      externalActionId: outcome.actionId,
      userId,
    }),
  );
  return { status: "unpublished", path: page.path, externalActionId: outcome.actionId };
}
