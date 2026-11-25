// The packs this deployment registers (ARCHITECTURE §12.1): the one place, with platform.ts, that
// names a pack; nothing in packages/* does. Each pack's tools are adapted to the tool registry's
// shape here, because a pack never imports packages/agents: the adapter hands each call the run's
// database and model transport (`ToolInvocation.packServices`) and the step's skill settings.

import type { InternalTool, PackToolSource } from "@countersign/agents";
import type { ContentStore } from "@countersign/connectors";
import type { PackReviewDecision } from "@countersign/core";
import {
  createMatchPort,
  lazy,
  lazyObjects,
  type MatchPort,
  type PackManifest,
  type ProfileMatcher,
  type ToolSpec,
} from "@countersign/core";
import type { Db, Tx } from "@countersign/db";
import type { LlmTransport } from "@countersign/llm";
import {
  BOOKKEEPING_ACTIONS,
  BOOKKEEPING_HANDLERS,
  BOOKKEEPING_NIGHTLY,
  BOOKKEEPING_REPORTS,
  BOOKKEEPING_REVIEWS,
  bookkeepingManifest,
  CLOSE_HANDLERS,
  CLOSE_REPORTS,
  CLOSE_REVIEWS,
  closeManifest,
} from "@countersign/pack-bookkeeping";
import {
  MARKETING_ACTIONS,
  MARKETING_HANDLERS,
  MARKETING_INBOUND,
  MARKETING_NIGHTLY,
  MARKETING_REPORTS,
  marketingManifest,
} from "@countersign/pack-marketing";
import {
  AP_HANDLERS,
  AP_REPORTS,
  AP_REVIEWS,
  apManifest,
  MATERIALS_ACTIONS,
  MATERIALS_HANDLERS,
  MATERIALS_MATCHERS,
  MATERIALS_REPORTS,
  MATERIALS_REVIEWS,
  materialsManifest,
  type PackTool,
  type PackToolContext,
  packToolContext,
} from "@countersign/pack-materials";
import {
  CRM_RECORDS_MATCHER,
  SALES_HANDLERS,
  SALES_REVIEWS,
  SALES_SYNCED,
  salesManifest,
} from "@countersign/pack-sales";
import type { z } from "zod";
import { reportHandled } from "./observability/report";
import type { SignedWrite } from "./signed-writes";

/**
 * A pack's report, as the generic report routes call it (routes/packs.ts). §1.73: with its
 * query parameters, checked by the pack's own `query` schema; a report without one gets `{}`.
 */
export interface PackReportHandler {
  title: string;
  query?: z.ZodType;
  json(
    tx: Tx,
    tenantId: string,
    today: string,
    query: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  csv(tx: Tx, tenantId: string, today: string, query: Record<string, unknown>): Promise<string>;
  /** P-9: one row in full (e.g. one purchase request); null when it isn't this client's. */
  item?(
    tx: Tx,
    tenantId: string,
    id: string,
    today: string,
    query: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null>;
}

/**
 * An inbox card a pack adds (`/api/inbox/:id/pack-review`), by the `review` key of the item's
 * payload. The pack checks its own decisions (a `ReviewError` is the card's 422).
 */
export interface PackReviewHandler {
  /** What the card shows, for this client only (the route's transaction is the client's). */
  load(
    tx: Tx,
    tenantId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  /** A person's decision about one part of the card; the pack opens its own transaction. */
  decide(
    db: Db,
    input: {
      tenantId: string;
      userId: string;
      payload: Record<string, unknown>;
      decision: PackReviewDecision;
      testRun: boolean;
    },
  ): Promise<void>;
  /**
   * §1.164: the card's search (`/api/inbox/:id/pack-review/lookup`), for a person picking a record
   * none of the card's suggestions is: this client's records only, at most 20.
   */
  lookup?(
    tx: Tx,
    tenantId: string,
    payload: Record<string, unknown>,
    query: { module?: string | undefined; q: string },
  ): Promise<Record<string, unknown>[]>;
  /**
   * §1.164: what the waiting run gets as the person step's answer when the card is finished, read
   * from what was recorded (never what the browser sent); a `ReviewError` refuses the finish.
   */
  answer?(
    tx: Tx,
    tenantId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

/** A back-office action on one client's pack data (a person's, never an agent's). */
export interface PackActionHandler {
  input: z.ZodType;
  run(
    db: Db,
    ctx: {
      tenantId: string;
      userId: string;
      input: unknown;
      /**
       * M46 (docs/plan.md §1.76): a change outside this person signs as they take the action
       * (publishing a guide), run once through its connector as an external action they
       * approved (signed-writes.ts). A pack that writes nothing outside never calls it.
       */
      signedWrite?: SignedWrite;
    },
  ): Promise<Record<string, unknown>>;
}

export interface RegisteredPack {
  manifest: PackManifest;
  handlers: Readonly<Record<string, PackTool>>;
  /** Its client reports by name (`/api/reports/:pack/:report`). */
  reports?: Readonly<Record<string, PackReportHandler>>;
  /**
   * M50 (docs/plan.md §1.78): the reports the portal may read (JSON, CSV and items); the others
   * are the back office's. Absent: every report (Materials').
   */
  portalReports?: readonly string[];
  /** Its inbox review cards by the `review` key of an item's payload (e.g. `materials.match`). */
  reviews?: Readonly<Record<string, PackReviewHandler>>;
  /** People's actions on a client's pack data from the back office (e.g. a catalog merge). */
  actions?: Readonly<Record<string, PackActionHandler>>;
  /**
   * M43: what it takes from outside with no session (`POST /api/in/:pack/:tenantId/:target`),
   * for a client that has it on: a measured site's beacon. The answer is always 204.
   */
  inbound?: PackInbound;
  /** M43: its nightly pass over every client with it on, at this UTC hour and minute. */
  nightly?: PackNightly;
  /**
   * §1.164: after a sync page of one of `connectors` committed, the pack's pass over the raw records
   * it stored (the Sales area builds its record keys). apps/api calls it for every client; the pack
   * skips a client that has it off. Deterministic: no model.
   */
  synced?: PackSynced;
  /**
   * M46: the reports whose items are pages a preview link may show (routes/pack-preview.ts):
   * each item a checked fragment `{ title, description, html, path, domain }`.
   */
  previews?: readonly string[];
  /**
   * Step model §7 (stream D): how the Match engine reaches the records of each match profile its
   * manifest declares (`matchProfiles`), one matcher per profile; `matchPort` gathers them all.
   */
  matchers?: readonly ProfileMatcher<PackToolContext>[];
}

/** What the inbound route hands a pack: the body (capped at `maxBytes`) and the request's facts. */
export interface PackInbound {
  maxBytes: number;
  receive(
    db: Db,
    req: {
      tenantId: string;
      target: string;
      body: string;
      ip: string;
      headers: Readonly<Record<string, string>>;
      cf?: Record<string, unknown> | undefined;
      now: Date;
    },
  ): Promise<unknown>;
}

export interface PackSynced {
  connectors: readonly string[];
  run(
    db: Db,
    input: { tenantId: string; connectionId: string; rawRecordIds: readonly string[] },
  ): Promise<unknown>;
}

export interface PackNightly {
  hour: number;
  minute: number;
  run(db: Db, now: Date, onError?: (tenantId: string, error: unknown) => void): Promise<unknown>;
}

/**
 * M50: the reports a pack's portal screens name (`/reports/<pack>/<report>`), for `portalReports`.
 */
// DECISION: the pack's own portal screens decide what its portal reads, so a pack lists a report
// once (its screen) and a new back-office report never reaches the portal by default.
export function screenReports(manifest: PackManifest): string[] {
  const prefix = `/reports/${manifest.id}/`;
  return manifest.screens
    .filter((s) => s.route.startsWith(prefix))
    .map((s) => s.route.slice(prefix.length).split("/")[0] ?? "")
    .filter((name) => name.length > 0);
}

/** Every pack the deployment registers. Enabling one for a client is a `tenant_pack` row. */
// Worker startup (2026-11-11): the portal's reports are read from the manifests on first use
// (core `lazy`), so loading this module doesn't parse them.
export const DEPLOYMENT_PACKS: readonly RegisteredPack[] = lazyObjects([
  {
    manifest: materialsManifest,
    handlers: MATERIALS_HANDLERS,
    reports: MATERIALS_REPORTS,
    reviews: MATERIALS_REVIEWS,
    actions: MATERIALS_ACTIONS,
    // §1.88: the portal reads the reports its screens name (prices, catalog, vendor catalog,
    // requests), and a master item's vendors, which the catalog screen's item page reads.
    // DECISION (§1.88 web): the client sees its vendor catalog read only (it is their data); the
    // preferred and discontinue actions stay the operator's (`/api/ops/…/actions`).
    portalReports: lazy(() => [...screenReports(materialsManifest), "master-vendors"]),
    // Step model §7: Vendors, Vendor items and Master items.
    matchers: MATERIALS_MATCHERS,
  },
  // Plan entry §1.233: the AP pack, extending the Purchasing area: bills prepared from invoices,
  // matched to their purchase orders, coded and flagged, and the week's approve-to-pay list (its
  // card). The portal reads its Bills to pay report (its screen's). Nothing in it pays.
  {
    manifest: apManifest,
    handlers: AP_HANDLERS,
    reports: AP_REPORTS,
    reviews: AP_REVIEWS,
    portalReports: lazy(() => screenReports(apManifest)),
  },
  // M43 (docs/plan.md §1.72): the Marketing area, Mezonas's own website first. §1.73: its tools
  // come from its areas, adapted like Materials' (the pack's tool context is a part of theirs).
  {
    manifest: marketingManifest,
    handlers: MARKETING_HANDLERS,
    reports: MARKETING_REPORTS,
    actions: MARKETING_ACTIONS,
    inbound: MARKETING_INBOUND,
    nightly: MARKETING_NIGHTLY,
    // M46: a guide's version before it is public (docs/plan.md §1.76).
    previews: ["content-preview"],
    // M50 (docs/plan.md §1.78): the client's portal reads the reports its screens name (website,
    // search, weekly report); the rest (visits, content, claims, the forum watch) stay in the
    // back office.
    portalReports: lazy(() => screenReports(marketingManifest)),
  },
  // B-3 (docs/plan.md §1.79): the Bookkeeping area, bank and card transactions into QuickBooks.
  // The portal reads its Bank transactions report; the chart of accounts and the rules are the
  // back office's (the client answers about accounts on the card).
  {
    manifest: bookkeepingManifest,
    handlers: BOOKKEEPING_HANDLERS,
    reports: BOOKKEEPING_REPORTS,
    reviews: BOOKKEEPING_REVIEWS,
    actions: BOOKKEEPING_ACTIONS,
    nightly: BOOKKEEPING_NIGHTLY,
    portalReports: lazy(() => screenReports(bookkeepingManifest)),
  },
  // docs/plan.md §1.232: the Close pack, extending the Bookkeeping area: a month's checklist, its
  // journal entries (written by the QuickBooks connector after approval) and the sign-off card.
  // The portal reads its close report (its screen's).
  {
    manifest: closeManifest,
    handlers: CLOSE_HANDLERS,
    reports: CLOSE_REPORTS,
    reviews: CLOSE_REVIEWS,
    portalReports: lazy(() => screenReports(closeManifest)),
  },
  // docs/plan.md §1.164: the Sales area's first version: record keys from the client's synced CRM
  // (built after each sync page), the match and the look-up, and the Confirm matches card
  // (`sales.match`, with its look-up and its answer). No reports or screens yet.
  {
    manifest: salesManifest,
    handlers: SALES_HANDLERS,
    reviews: SALES_REVIEWS,
    synced: SALES_SYNCED,
    // Step model §7: CRM records.
    matchers: [CRM_RECORDS_MATCHER],
  },
]);

let port: MatchPort<PackToolContext> | null = null;

/**
 * Step model §7 (stream D): the Match engine behind a Match step, with every registered pack's
 * profiles. The executor calls `match` with the call's pack tool context (`packToolContext`, as
 * `adapt` builds it), the step's Match settings, the items, and its model chooser; and `learn`
 * with a person's answer. A pack's profile is reached whether or not the client has the pack on:
 * the publish checks and the area's own records decide what a client's step can match.
 */
// DECISION: one port for the deployment, built on first use; the platform names no pack here
// beyond registering it, as for tools and reports (invariant 2).
export function matchPort(): MatchPort<PackToolContext> {
  port ??= createMatchPort(DEPLOYMENT_PACKS.flatMap((p) => p.matchers ?? []));
  return port;
}

/**
 * The model transport a pack tool's call gets: the run's, only for a tool that declares
 * `usesModel`; null for every other (its `llm` is null). The skill model's "hidden AI" is never
 * unlabelled: a pack tool that calls a model without saying so has none to call.
 */
export function packToolTransport(
  spec: Pick<ToolSpec, "usesModel">,
  services: Readonly<Record<string, unknown>> | undefined,
): LlmTransport | null {
  if (spec.usesModel === undefined) return null;
  return (services?.transport as LlmTransport | null | undefined) ?? null;
}

/**
 * Brings what a connector's sync saved up to date for one client before a tool reads it
 * (`ToolSpec.feed`; apps/api `feeds.ts`). A feed it can't catch up is left as it is.
 */
export type FeedCatchUp = (tenantId: string, feed: string) => Promise<void>;

/**
 * 2026-11-24: before a pack tool that reads a connector's synced records (`feed`), the run's
 * catch-up (packServices.catchUp) reads what changed in the client's tool. A failed catch-up never
 * fails the step: the tool reads what we hold, and the failure is reported.
 */
export async function catchUpFeed(
  spec: Pick<ToolSpec, "id" | "feed">,
  tenantId: string,
  services: Readonly<Record<string, unknown>> | undefined,
): Promise<void> {
  const catchUp = services?.catchUp as FeedCatchUp | null | undefined;
  if (!spec.feed || !catchUp) return;
  try {
    await catchUp(tenantId, spec.feed);
  } catch (error) {
    reportHandled(`${spec.feed} catch-up before ${spec.id} failed`, error, {
      job: "feed_catch_up",
      client: tenantId,
    });
  }
}

function adapt(tool: PackTool): InternalTool {
  return {
    spec: tool.spec,
    input: tool.input,
    output: tool.output,
    async run(input, ctx) {
      const db = ctx.packServices?.db as Db | undefined;
      if (!db) throw new Error(`${tool.spec.id} needs the run's database, which wasn't passed`);
      await catchUpFeed(tool.spec, ctx.tenantId, ctx.packServices);
      // Skill model (2026-11-10): only a tool that declares it calls a model (`usesModel`) is
      // handed one; every other pack tool gets `llm: null`, so it can't call a model unlabelled.
      const transport = packToolTransport(tool.spec, ctx.packServices);
      // P-5: the client's document storage, for a document a pack tool makes (a purchase order).
      const content = (ctx.packServices?.content as ContentStore | null | undefined) ?? null;
      return tool.run(
        input,
        packToolContext({
          tenantId: ctx.tenantId,
          agentVersionId: ctx.agentVersionId,
          runId: ctx.runId,
          // §1.164: the step a decision records (the Sales area's matches).
          stepId: ctx.stepId,
          mode: ctx.mode,
          settings: ctx.settings,
          db,
          transport,
          recordUsage: ctx.recordUsage,
          // §1.115: a pack tool's model call is its step's `model_call` too, as a platform tool's.
          recordModelCall: ctx.recordModelCall,
          content,
        }),
      );
    },
  };
}

/** A pack's tools as the tool registry takes them. */
export function packToolSource(pack: RegisteredPack): PackToolSource {
  return {
    manifest: pack.manifest,
    handlers: Object.fromEntries(
      Object.entries(pack.handlers).map(([id, tool]) => [id, adapt(tool)]),
    ),
  };
}
