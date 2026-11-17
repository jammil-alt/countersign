// What the Dev queue reads of the catalog (docs/plan.md §1.125): the index the reuse check
// searches, and whether a part a request expects is in this deployment's catalog yet (the ship
// check). A part is a tool id or skill ref, a connector or pack id, or one operation of a part
// (`data.reshape#dateOffset`): Reshape's operations are its expression kinds; another tool's are
// the property names and allowed values of its input.

import { type CatalogEntry, indexCatalog, type RequestEntry } from "@countersign/agents";
import { processes, readSpec, splitPartId } from "@countersign/core";
import { codeRequest, type Tx } from "@countersign/db";
import { inArray } from "drizzle-orm";
import type { Scoped, Services } from "../http";
import type { Platform } from "../platform";
import { builderContext as apiBuilderContext } from "../routes/ops-builder";

/** The requests the index reads: open and shipped ones (closed ones are settled). */
export async function requestEntries(tx: Tx): Promise<RequestEntry[]> {
  const rows = await tx
    .select()
    .from(codeRequest)
    .where(inArray(codeRequest.status, ["triage", "accepted", "in_progress", "shipped"]));
  return rows.map((r) => {
    const spec = readSpec(r.spec);
    return {
      id: r.id,
      number: r.number,
      title: r.title,
      summary: spec.summary,
      inputs: spec.inputs,
      outputs: spec.outputs,
      open: r.status !== "shipped",
      shippedPartId: r.shippedPartId ?? null,
    };
  });
}

/** The catalog (for everyone, no client) and the requests, as the reuse check searches them. */
export async function reuseIndex(
  scoped: Scoped,
  services: Services,
): Promise<{ index: CatalogEntry[]; ctx: Awaited<ReturnType<typeof apiBuilderContext>> }> {
  const ctx = await apiBuilderContext({ ...scoped, services }, null);
  return { index: indexCatalog(ctx, await requestEntries(scoped.tx)), ctx };
}

function words(schema: unknown): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 8 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const x of v) {
        if (typeof x === "string") out.add(x);
        else walk(x, depth + 1);
      }
      return;
    }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === "properties" && x && typeof x === "object") {
        for (const p of Object.keys(x as object)) out.add(p);
      }
      if (k === "const" && typeof x === "string") out.add(x);
      walk(x, depth + 1);
    }
  };
  walk(schema, 0);
  return out;
}

/** The part, if this deployment's catalog has it: its name. */
export function findPart(platform: Platform, partId: string): { name: string } | null {
  const { base, operation } = splitPartId(partId);
  if (!base) return null;
  const tool = platform.tools.get(base)?.spec;
  const skill = platform.catalog.list().find((s) => s.id === base);
  if (!operation) {
    if (tool) return { name: firstSentence(tool.description) || tool.id };
    if (skill) return { name: skill.name };
    const connector = platform.connectors.list().find((c) => c.manifest.id === base);
    if (connector) return { name: connector.manifest.name };
    const pack = platform.packs.find((p) => p.manifest.id === base);
    return pack ? { name: pack.manifest.name } : null;
  }
  if (base === processes.RESHAPE_TOOL) {
    return (processes.RESHAPE_EXPR_KINDS as readonly string[]).includes(operation)
      ? { name: `Reshape data: ${operation}` }
      : null;
  }
  const schema = tool?.input ?? skill?.input;
  if (!schema) return null;
  return words(schema).has(operation)
    ? { name: `${tool ? firstSentence(tool.description) || tool.id : skill?.name}: ${operation}` }
    : null;
}

function firstSentence(text: string): string {
  const s = text.trim().split(/(?<=[.!?])\s+/)[0] ?? "";
  return s.replace(/[.\s]+$/, "").slice(0, 120);
}
