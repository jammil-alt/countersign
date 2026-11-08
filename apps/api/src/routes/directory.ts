// The directory (docs/plan.md §1.27): the back office edits any served client's; the portal's
// client admin edits its own, and its client users read it. People are edited through the contact
// routes (routes/contacts.ts); organizations, the vendor link, imports and agents' suggestions are
// here. Every change is logged (`contact_change`, `organization_change`).

import {
  contactAccess,
  DIRECTORY_LIST_MAX,
  DIRECTORY_SUGGESTION_SUBJECT,
  type DirectoryList,
  type DirectoryListQuery,
  routes,
} from "@countersign/core";
import {
  clientLanguageOf,
  directoryOrganizations,
  directoryPeople,
  inboxItem,
  rankOrganizations,
  rankPeople,
  type Tx,
} from "@countersign/db";
import type { EventRow } from "@countersign/senses";
import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import {
  applyImport,
  importSources,
  preview,
  rowsFromConnector,
  rowsFromCsv,
} from "../directory/import";
import {
  createOrganization,
  linkVendor,
  organizationOut,
  organizationView,
  unlinkVendor,
  updateOrganization,
} from "../directory/organizations";
import { listSuggestions, openSuggestionCount, suggestionViews } from "../directory/suggestions";
import { type AppEnv, ensureClient, type HandlerCtx, mount, notFound } from "../http";
import { resolveInboxItem } from "../inbox";
import { contactView } from "../messaging/contacts";
import { dispatchEvents } from "../runs/dispatch";
import { knowsSignIns, membersOf } from "./onboarding";

export async function directoryList(
  tx: Tx,
  tenantId: string,
  q: DirectoryListQuery,
  /**
   * Whether each person can sign in (2026-11-08), for the client admin and the operator; null
   * leaves it out (client users don't need it). `signIns`: whether sign-in records a first one.
   */
  access: { signIns: boolean } | null = null,
): Promise<DirectoryList> {
  const wantPeople = q.type !== "organization";
  const client = await clientLanguageOf(tx, tenantId);
  const wantOrgs =
    q.type !== "person" &&
    q.relationship === undefined &&
    q.role === undefined &&
    q.organizationId === undefined;
  const people = wantPeople
    ? rankPeople(
        await directoryPeople(tx, tenantId, {
          relationship: q.relationship,
          role: q.role,
          organizationId: q.organizationId,
          kind: q.kind,
        }),
        q.q,
        DIRECTORY_LIST_MAX,
      ).map((r) => contactView(r.item.person, r.item.organization, client))
    : [];
  if (access && people.length > 0) {
    // DECISION: the status comes from the members the API already lists (an invite is a
    // membership): no new table, no migration. Matched by email, lower case.
    const members = await membersOf(tx, tenantId, {
      clientRolesOnly: false,
      signIns: access.signIns,
    });
    for (const p of people) p.access = contactAccess(p.email, members);
  }
  const organizations = wantOrgs
    ? rankOrganizations(
        await directoryOrganizations(tx, tenantId, { kind: q.kind }),
        q.q,
        DIRECTORY_LIST_MAX,
      ).map((r) => organizationView(r.item, client))
    : [];
  return { people, organizations, pendingSuggestions: await openSuggestionCount(tx, tenantId) };
}

/** Accept or decline a suggestion through the inbox's own resolution, so it is one decision. */
async function resolveSuggestion(
  ctx: Pick<
    HandlerCtx<typeof routes.portalDirectorySuggestionResolve>,
    "tx" | "services" | "defer"
  >,
  tenantId: string,
  itemId: string,
  by: { userId: string; role: "operator" | "client_admin" | "client_user" },
  body: { decision: "approve" | "reject"; note?: string | undefined },
) {
  const [item] = await ctx.tx
    .select({ id: inboxItem.id })
    .from(inboxItem)
    .where(
      and(
        eq(inboxItem.id, itemId),
        eq(inboxItem.tenantId, tenantId),
        eq(inboxItem.subjectType, DIRECTORY_SUGGESTION_SUBJECT),
      ),
    );
  if (!item) throw notFound("suggestion");
  const collect: EventRow[] = [];
  const outcome = await resolveInboxItem(ctx.tx, {
    tenantId,
    itemId,
    by,
    body,
    registry: ctx.services.platform.events,
    collect,
  });
  if (collect.length > 0) {
    const { db, instances } = ctx.services;
    ctx.defer(() => dispatchEvents({ db, instances }, collect));
  }
  const [view] = await suggestionViews(ctx.tx, tenantId, [outcome.item]);
  if (!view) throw notFound("suggestion");
  return { suggestion: view };
}

export function directoryRoutes(app: Hono<AppEnv>): void {
  // ── Back office ──
  mount(app, routes.opsDirectory, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    return directoryList(ctx.tx, ctx.params.id, ctx.query, { signIns: knowsSignIns(ctx) });
  });
  mount(app, routes.opsOrganizationCreate, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    const row = await createOrganization(ctx.tx, ctx.params.id, ctx.body, ctx.session.user.id);
    return { organization: await organizationOut(ctx.tx, ctx.params.id, row.id) };
  });
  mount(app, routes.opsOrganizationUpdate, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    const { id, organizationId } = ctx.params;
    await updateOrganization(ctx.tx, id, organizationId, ctx.body, ctx.session.user.id);
    return { organization: await organizationOut(ctx.tx, id, organizationId) };
  });
  mount(app, routes.opsOrganizationLinkVendor, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    const { id, organizationId } = ctx.params;
    await linkVendor(ctx.tx, id, organizationId, ctx.session.user.id);
    return { organization: await organizationOut(ctx.tx, id, organizationId) };
  });
  mount(app, routes.opsOrganizationUnlinkVendor, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    const { id, organizationId } = ctx.params;
    await unlinkVendor(ctx.tx, id, organizationId, ctx.session.user.id);
    return { organization: await organizationOut(ctx.tx, id, organizationId) };
  });
  mount(app, routes.opsDirectoryImportSources, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    return { sources: await importSources(ctx.tx, ctx.params.id) };
  });
  mount(app, routes.opsDirectoryImportCsv, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    const rows = rowsFromCsv(ctx.body.kind, ctx.body.csv);
    return preview(ctx.tx, ctx.params.id, ctx.body.kind, "csv", rows);
  });
  mount(app, routes.opsDirectoryImportConnector, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    const read = await rowsFromConnector(ctx.tx, ctx.params.id, ctx.body, ctx.services);
    return preview(ctx.tx, ctx.params.id, ctx.body.kind, read.source, read.rows, read.more);
  });
  mount(app, routes.opsDirectoryImportApply, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    return apply(ctx, ctx.params.id);
  });
  mount(app, routes.opsDirectorySuggestions, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    return { items: await listSuggestions(ctx.tx, ctx.params.id, ctx.query.status) };
  });
  mount(app, routes.opsDirectorySuggestionResolve, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    return resolveSuggestion(
      ctx,
      ctx.params.id,
      ctx.params.suggestionId,
      { userId: ctx.session.user.id, role: "operator" },
      ctx.body,
    );
  });

  // ── Portal ──
  const client = (ctx: { tenantIds: readonly string[] }) => ctx.tenantIds[0] as string;
  mount(app, routes.portalDirectory, async (ctx) =>
    directoryList(
      ctx.tx,
      client(ctx),
      ctx.query,
      ctx.role === "client_admin" ? { signIns: knowsSignIns(ctx) } : null,
    ),
  );
  mount(app, routes.portalOrganizationCreate, async (ctx) => {
    const row = await createOrganization(ctx.tx, client(ctx), ctx.body, ctx.session.user.id);
    return { organization: await organizationOut(ctx.tx, client(ctx), row.id) };
  });
  mount(app, routes.portalOrganizationUpdate, async (ctx) => {
    await updateOrganization(ctx.tx, client(ctx), ctx.params.id, ctx.body, ctx.session.user.id);
    return { organization: await organizationOut(ctx.tx, client(ctx), ctx.params.id) };
  });
  mount(app, routes.portalOrganizationLinkVendor, async (ctx) => {
    await linkVendor(ctx.tx, client(ctx), ctx.params.id, ctx.session.user.id);
    return { organization: await organizationOut(ctx.tx, client(ctx), ctx.params.id) };
  });
  mount(app, routes.portalOrganizationUnlinkVendor, async (ctx) => {
    await unlinkVendor(ctx.tx, client(ctx), ctx.params.id, ctx.session.user.id);
    return { organization: await organizationOut(ctx.tx, client(ctx), ctx.params.id) };
  });
  mount(app, routes.portalDirectoryImportSources, async (ctx) => ({
    sources: await importSources(ctx.tx, client(ctx)),
  }));
  mount(app, routes.portalDirectoryImportCsv, async (ctx) => {
    const rows = rowsFromCsv(ctx.body.kind, ctx.body.csv);
    return preview(ctx.tx, client(ctx), ctx.body.kind, "csv", rows);
  });
  mount(app, routes.portalDirectoryImportConnector, async (ctx) => {
    const read = await rowsFromConnector(ctx.tx, client(ctx), ctx.body, ctx.services);
    return preview(ctx.tx, client(ctx), ctx.body.kind, read.source, read.rows, read.more);
  });
  mount(app, routes.portalDirectoryImportApply, async (ctx) => apply(ctx, client(ctx)));
  mount(app, routes.portalDirectorySuggestions, async (ctx) => ({
    items: await listSuggestions(ctx.tx, client(ctx), ctx.query.status),
  }));
  mount(app, routes.portalDirectorySuggestionResolve, async (ctx) =>
    resolveSuggestion(
      ctx,
      client(ctx),
      ctx.params.id,
      { userId: ctx.session.user.id, role: ctx.role },
      ctx.body,
    ),
  );
}

async function apply(
  ctx: Pick<HandlerCtx<typeof routes.portalDirectoryImportApply>, "tx" | "body" | "session">,
  tenantId: string,
) {
  const body = ctx.body;
  if (body.source === "csv") {
    const rows = rowsFromCsv(body.kind, body.csv);
    return applyImport(ctx.tx, tenantId, body, rows, "csv", ctx.session.user.id);
  }
  // Rows a connector preview gave, sent back as the person chose them. They are checked again
  // here like any input, and matched by their id in that tool.
  const conn = await importSources(ctx.tx, tenantId);
  const source = conn.find((s) => s.connectionId === body.connectionId);
  if (!source) throw notFound("connection");
  const list = (body.kind === "people" ? body.people : body.organizations) ?? [];
  const rows = list.map((data, i) => ({ row: i + 1, data, problems: [] }));
  return applyImport(ctx.tx, tenantId, body, rows, source.connector, ctx.session.user.id);
}
