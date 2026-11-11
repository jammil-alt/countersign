// How an external action reads on its card ("now / after this change"; core ChangeDisplayView): the
// connector's name as people know it and the tool's display spec, looked up in the registry when a
// response is built, so the inbox and run views of both surfaces read every item the same way,
// including items proposed before their tool declared a display.
import {
  type ChangeDisplayView,
  clientLabel,
  findNodeStep,
  isPlainObject,
  type Locale,
  pickLocalized,
  stepNodeOf,
} from "@countersign/core";
import { agentVersion, run, type Tx } from "@countersign/db";
import { and, inArray } from "drizzle-orm";
import type { Platform } from "./platform";

type Registries = Pick<Platform, "tools" | "connectors">;

/** The view for a write tool, or null when its connector is not registered. */
export function changeDisplay(platform: Registries, toolId: unknown): ChangeDisplayView | null {
  if (typeof toolId !== "string") return null;
  const tool = platform.tools.get(toolId);
  const connectorId = tool?.spec.connector ?? toolId.split(".")[0] ?? toolId;
  const manifest = platform.connectors.get(connectorId)?.manifest;
  if (!manifest) return null;
  return { connectorName: manifest.name, tool: tool?.spec.display ?? null };
}

interface ItemLike {
  kind: string;
  title: string;
  payload: unknown;
}

/** An inbox item's view: external actions only. */
export function itemDisplay(platform: Registries, item: ItemLike): ChangeDisplayView | null {
  if (item.kind !== "external_action" || !isPlainObject(item.payload)) return null;
  return changeDisplay(platform, item.payload.tool);
}

/**
 * An external action's title without the tool id that titles carried until the tools described
 * themselves ("Itemize a QuickBooks bill… (qbo.bill.update_lines)"): tool ids are not for clients.
 */
export function plainTitle(item: ItemLike): string {
  const tool = isPlainObject(item.payload) ? item.payload.tool : undefined;
  if (item.kind !== "external_action" || typeof tool !== "string") return item.title;
  const suffix = ` (${tool})`;
  return item.title.endsWith(suffix) ? item.title.slice(0, -suffix.length) : item.title;
}

interface TitledItem extends ItemLike {
  id: string;
  tenantId: string;
  runId: string | null;
}

/**
 * The titles clients read for inbox items (QA round 1): an external action never reads as the
 * tool's description, which is written for the agent ("replace lines (usually its one account
 * line)…") and which items proposed before their tool declared a display still carry. It reads
 * as the tool's line for people (its display description, as items proposed since are titled),
 * else as its step's client-facing label (the run timeline's words). Other items, and an action
 * with neither, keep `plainTitle`.
 */
// DECISION: resolved when a response is built, from the registry and the run's own version, so
// items proposed earlier read the same way and nothing stored is rewritten.
export async function clientTitles(
  tx: Tx,
  items: readonly TitledItem[],
  platform: Pick<Platform, "tools">,
  locale?: Locale,
): Promise<Map<string, string>> {
  const out = new Map(items.map((i) => [i.id, plainTitle(i)]));
  const wanted: TitledItem[] = [];
  for (const i of items) {
    if (i.kind !== "external_action" || !isPlainObject(i.payload)) continue;
    const { tool, stepId } = i.payload;
    const line =
      typeof tool === "string" ? platform.tools.get(tool)?.spec.display?.description : undefined;
    if (line) out.set(i.id, pickLocalized(line, locale));
    else if (i.runId !== null && typeof stepId === "string") wanted.push(i);
  }
  if (wanted.length === 0) return out;
  const runs = await tx
    .select({
      id: run.id,
      tenantId: run.tenantId,
      agentVersionId: run.agentVersionId,
      workflowSlug: run.workflowSlug,
    })
    .from(run)
    .where(
      and(
        inArray(run.tenantId, [...new Set(wanted.map((i) => i.tenantId))]),
        inArray(run.id, [...new Set(wanted.map((i) => i.runId as string))]),
      ),
    );
  const versionIds = [...new Set(runs.map((r) => r.agentVersionId))];
  const versions =
    versionIds.length === 0
      ? []
      : await tx
          .select({ id: agentVersion.id, bundle: agentVersion.bundle })
          .from(agentVersion)
          .where(
            and(
              inArray(agentVersion.id, versionIds),
              inArray(agentVersion.tenantId, [...new Set(runs.map((r) => r.tenantId))]),
            ),
          );
  const bundles = new Map(versions.map((v) => [v.id, v.bundle]));
  const runsById = new Map(runs.map((r) => [r.id, r]));
  for (const i of wanted) {
    const r = runsById.get(i.runId as string);
    if (!r || r.tenantId !== i.tenantId) continue;
    const workflow = bundles
      .get(r.agentVersionId)
      ?.workflows.find((w) => w.slug === r.workflowSlug);
    const nodeId = (i.payload as { stepId: string }).stepId;
    // A step inside a loop is named `${loop}:${index}:${childId}`.
    // Wave 3b: a v3 workflow's or a v4 process's step alike.
    // A retried or helped write's node carries a suffix (`<node>:o1`): read the step before it.
    const step = workflow ? findNodeStep(workflow.workflow, stepNodeOf(nodeId).node) : undefined;
    if (step) out.set(i.id, clientLabel(step));
  }
  return out;
}
