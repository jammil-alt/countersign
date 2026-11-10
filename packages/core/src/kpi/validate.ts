// The client view's checks (docs/plan.md §1.50): KPI ids unique, a step measure's step is a step
// of the bundle, a runs measure's workflow is one of its workflows, ratios nest at most twice,
// panels name KPIs that exist and packs that are installed. The schema already checked the paths
// (dotted identifiers). Called by validateBundle, so the builder and the server share it.

import { walkSteps as walkProcessSteps } from "../process/walk";
import type { AnyAgentBundle } from "../schemas/agent";
import type { ValidationError } from "../workflow/validate";
import { walkSteps } from "../workflow/walk";
import { KPI_RATIO_MAX_DEPTH, type Measure, plainMeasures, ratioDepth } from "./schema";

export interface ClientViewContext {
  /**
   * The packs installed where the bundle runs (a client agent: its client's enabled packs). When
   * absent, pack panels are not checked (templates and drafts: checked when a client publishes).
   */
  packs?: readonly string[];
}

/**
 * Every step id of every workflow of the bundle, at any depth. A `use_automation` step is one of
 * them: a KPI may read its output (the automation's declared `output`).
 */
// DECISION: a KPI never names an automation's inner steps: they are not in the bundle and nothing
// outside the use step sees them (ARCHITECTURE §10.7); a KPI on an automation's work reads the use
// step's output. Their node ids (`<use>/<inner>`) never match a step measure in compute.ts.
// R8: a v4 process's steps count the same way (a bundle the builder saves holds processes).
function stepIds(bundle: Pick<AnyAgentBundle, "workflows">): Set<string> {
  const ids = new Set<string>();
  for (const w of bundle.workflows) {
    if (w.workflow.schemaVersion === 4) {
      walkProcessSteps(w.workflow, ({ step }) => ids.add(step.id));
    } else walkSteps(w.workflow, ({ step }) => ids.add(step.id));
  }
  return ids;
}

export function validateClientView(
  bundle: Pick<AnyAgentBundle, "definition" | "workflows">,
  ctx: ClientViewContext = {},
): ValidationError[] {
  const view = bundle.definition.clientView;
  if (!view) return [];
  const errors: ValidationError[] = [];
  const add = (field: string, code: ValidationError["code"], message: string) =>
    errors.push({ stepId: null, field: `definition.clientView.${field}`, code, message });

  const steps = stepIds(bundle);
  const slugs = new Set(bundle.workflows.map((w) => w.slug));
  const kpiIds = new Set<string>();
  view.kpis.forEach((k, i) => {
    if (kpiIds.has(k.id)) add(`kpis.${i}.id`, "duplicate_kpi", `KPI "${k.id}" is used twice`);
    kpiIds.add(k.id);
    if (ratioDepth(k.measure) > KPI_RATIO_MAX_DEPTH) {
      add(
        `kpis.${i}.measure`,
        "kpi_ratio_depth",
        `a ratio nests at most ${KPI_RATIO_MAX_DEPTH} deep`,
      );
    }
    for (const m of plainMeasures(k.measure as Measure)) {
      if ((m.kind === "sum" || m.kind === "count") && !steps.has(m.step)) {
        add(`kpis.${i}.measure`, "kpi_unknown_step", `no step "${m.step}" in this agent`);
      }
      if (m.kind === "runs" && m.workflow !== undefined && !slugs.has(m.workflow)) {
        add(
          `kpis.${i}.measure`,
          "kpi_unknown_workflow",
          `no workflow "${m.workflow}" in this agent`,
        );
      }
    }
  });
  const panelIds = new Set<string>();
  view.panels.forEach((p, i) => {
    if (panelIds.has(p.id)) add(`panels.${i}.id`, "duplicate_kpi", `panel "${p.id}" is used twice`);
    panelIds.add(p.id);
    if (p.kind === "kpis") {
      for (const id of p.kpis) {
        if (!kpiIds.has(id)) add(`panels.${i}.kpis`, "kpi_unknown", `no KPI "${id}" in this view`);
      }
    } else if (ctx.packs && !ctx.packs.includes(p.pack)) {
      add(`panels.${i}.pack`, "kpi_pack_missing", `the ${p.pack} pack is not installed`);
    }
  });
  return errors;
}
