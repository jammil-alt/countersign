// The packs this deployment registers (ARCHITECTURE §12.1): the one place, with platform.ts, that
// names a pack; nothing in packages/* does. Each pack's tools are adapted to the tool registry's
// shape here, because a pack never imports packages/agents: the adapter hands each call the run's
// database and model transport (`ToolInvocation.packServices`) and the step's skill settings.

import type { InternalTool, PackToolSource } from "@countersign/agents";
import type { ContentStore } from "@countersign/connectors";
import type { PackManifest } from "@countersign/core";
import type { Db, Tx } from "@countersign/db";
import type { LlmTransport } from "@countersign/llm";
import {
  MARKETING_ACTIONS,
  MARKETING_HANDLERS,
  MARKETING_INBOUND,
  MARKETING_NIGHTLY,
  MARKETING_REPORTS,
  marketingManifest,
} from "@countersign/pack-marketing";
import {
  MATERIALS_ACTIONS,
  MATERIALS_HANDLERS,
  MATERIALS_REPORTS,
  MATERIALS_REVIEWS,
  materialsManifest,
  type PackReviewHandler,
  type PackTool,
  packToolContext,
} from "@countersign/pack-materials";
import type { z } from "zod";
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
   * M46: the reports whose items are pages a preview link may show (routes/pack-preview.ts):
   * each item a checked fragment `{ title, description, html, path, domain }`.
   */
  previews?: readonly string[];
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
export const DEPLOYMENT_PACKS: readonly RegisteredPack[] = [
  {
    manifest: materialsManifest,
    handlers: MATERIALS_HANDLERS,
    reports: MATERIALS_REPORTS,
    reviews: MATERIALS_REVIEWS,
    actions: MATERIALS_ACTIONS,
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
    portalReports: screenReports(marketingManifest),
  },
];

function adapt(tool: PackTool): InternalTool {
  return {
    spec: tool.spec,
    input: tool.input,
    output: tool.output,
    async run(input, ctx) {
      const db = ctx.packServices?.db as Db | undefined;
      if (!db) throw new Error(`${tool.spec.id} needs the run's database, which wasn't passed`);
      const transport = (ctx.packServices?.transport as LlmTransport | null | undefined) ?? null;
      // P-5: the client's document storage, for a document a pack tool makes (a purchase order).
      const content = (ctx.packServices?.content as ContentStore | null | undefined) ?? null;
      return tool.run(
        input,
        packToolContext({
          tenantId: ctx.tenantId,
          agentVersionId: ctx.agentVersionId,
          runId: ctx.runId,
          mode: ctx.mode,
          settings: ctx.settings,
          db,
          transport,
          recordUsage: ctx.recordUsage,
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
