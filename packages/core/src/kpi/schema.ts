// Agent KPIs and the client view (ARCHITECTURE §9.9; docs/plan.md §1.50, W2-G). A template declares
// in its bundle what its client agents show the client: KPIs (a label, a period, a format and a
// measure over the agent's live runs) and panels (groups of KPIs, or a pack's report). The bundle
// carries the definition; the portal gets labels and values, never the definition.

import { z } from "zod";
import { LocalizedString } from "../i18n/locale";
import { NodeId, Slug, ToolId } from "../schemas/common";

export const KPI_PERIODS = ["7d", "30d", "month", "week"] as const;
export const KpiPeriod = z.enum(KPI_PERIODS);
export type KpiPeriod = z.infer<typeof KpiPeriod>;

export const KPI_FORMATS = ["count", "money", "percent"] as const;
export const KpiFormat = z.enum(KPI_FORMATS);
export type KpiFormat = z.infer<typeof KpiFormat>;

/** A ratio nests at most this deep (a ratio of ratios, never deeper). */
export const KPI_RATIO_MAX_DEPTH = 2;
/** The longest output path a measure may name. */
export const KPI_PATH_MAX = 200;
/** At most this many KPIs and panels in one client view. */
export const KPI_MAX = 24;

/** Path segments that would walk a JavaScript object's prototype: never a path segment. */
const PROTO_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * A step output path: identifiers joined by dots (`match.autoMatched`), no indexes, no wildcards.
 * Checked by splitting, not by one regular expression over the whole text, so the check is linear.
 */
// DECISION: identifiers are letters, digits and `_`, starting with a letter or `_`; the three
// prototype names are refused even though the SQL path (`#>>`) could not walk a prototype.
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function kpiPathProblem(path: string): string | null {
  if (path.length === 0 || path.length > KPI_PATH_MAX) {
    return `a path is 1 to ${KPI_PATH_MAX} characters`;
  }
  for (const segment of path.split(".")) {
    if (!IDENT.test(segment)) return "a path is identifiers joined by dots, e.g. match.matched";
    if (PROTO_SEGMENTS.has(segment)) return `"${segment}" can't be part of a path`;
  }
  return null;
}

export const KpiPath = z.string().superRefine((path, ctx) => {
  const problem = kpiPathProblem(path);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});

/** KPI and panel ids: letters, digits, `-` and `_`, like step ids. */
export const KpiId = NodeId;

export type Measure =
  | { kind: "runs"; status?: "succeeded" | "failed" | "any" | undefined; workflow?: string | undefined }
  | {
      kind: "actions";
      tool?: string | undefined;
      connector?: string | undefined;
      status: "done";
    }
  | { kind: "sum" | "count"; step: string; path: string; money?: boolean | undefined }
  | { kind: "ratio"; numerator: Measure; denominator: Measure };

export const RunsMeasure = z.strictObject({
  kind: z.literal("runs"),
  /** Default `any`. */
  status: z.enum(["succeeded", "failed", "any"]).optional(),
  /** Only this workflow's runs. */
  workflow: Slug.optional(),
});

export const ActionsMeasure = z.strictObject({
  kind: z.literal("actions"),
  tool: ToolId.optional(),
  connector: z
    .string()
    .regex(/^[a-z][a-z0-9_-]*$/, "a connector id, e.g. qbo")
    .optional(),
  status: z.literal("done"),
});

export const StepMeasure = z.strictObject({
  kind: z.enum(["sum", "count"]),
  /** The step whose output is read (a step id of the bundle, at any depth). */
  step: NodeId,
  path: KpiPath,
  /** The values are money: summed as decimals and shown with their currency. */
  money: z.boolean().optional(),
});

export const Measure: z.ZodType<Measure> = z.lazy(() =>
  z.union([
    RunsMeasure,
    ActionsMeasure,
    StepMeasure,
    z.strictObject({ kind: z.literal("ratio"), numerator: Measure, denominator: Measure }),
  ]),
) as z.ZodType<Measure>;

export const Kpi = z.strictObject({
  id: KpiId,
  label: LocalizedString,
  period: KpiPeriod,
  format: KpiFormat,
  measure: Measure,
});
export type Kpi = z.infer<typeof Kpi>;

export const Panel = z.discriminatedUnion("kind", [
  z.strictObject({ id: KpiId, kind: z.literal("kpis"), kpis: z.array(KpiId).min(1) }),
  z.strictObject({
    id: KpiId,
    kind: z.literal("pack_report"),
    pack: z.string().regex(/^[a-z][a-z0-9-]*$/, "a pack id, e.g. materials"),
    report: Slug,
  }),
]);
export type Panel = z.infer<typeof Panel>;

/**
 * `AgentDefinition.clientView` (ARCHITECTURE §9.9): optional with no default, so older bundles
 * hash the same. In merges its lists are whole values: both sides changing them conflicts.
 */
export const ClientView = z
  .strictObject({
    kpis: z.array(Kpi).max(KPI_MAX),
    panels: z.array(Panel).max(KPI_MAX),
  })
  .meta({ id: "ClientView" });
export type ClientView = z.infer<typeof ClientView>;

/** How deep a measure's ratios nest: 0 for a plain measure, 1 for a ratio of plain ones. */
export function ratioDepth(m: Measure): number {
  if (m.kind !== "ratio") return 0;
  return 1 + Math.max(ratioDepth(m.numerator), ratioDepth(m.denominator));
}

/** Every plain (non-ratio) measure inside a measure, in order. */
export function plainMeasures(m: Measure): Exclude<Measure, { kind: "ratio" }>[] {
  return m.kind === "ratio"
    ? [...plainMeasures(m.numerator), ...plainMeasures(m.denominator)]
    : [m];
}
