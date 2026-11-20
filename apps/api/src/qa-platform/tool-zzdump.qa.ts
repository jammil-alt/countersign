import { writeFileSync } from "node:fs";
import { it } from "vitest";
import { z } from "zod";
import { createPlatform, deploymentConnectors } from "../platform";

it("dump", () => {
  const env = { ENVIRONMENT: "development", OAUTH_STATE_SECRET: "x" } as never;
  const p = createPlatform({ connectors: deploymentConnectors(env, false) });
  const rows: unknown[] = [];
  for (const t of p.tools.list()) {
    const s = t.spec;
    let inZ = false;
    let outZ = false;
    let beforeZ: boolean | null = null;
    let handlerKind = "";
    if (t.kind === "internal") {
      inZ = t.tool.input instanceof z.ZodType;
      outZ = t.tool.output instanceof z.ZodType;
      handlerKind = "internal";
    } else {
      const h = t.connector.tools[s.id];
      handlerKind = h?.kind ?? "missing";
      inZ = h?.input instanceof z.ZodType;
      outZ = h?.output instanceof z.ZodType;
      if (h?.kind === "write") beforeZ = h.beforeSchema instanceof z.ZodType;
    }
    const providers = t.kind === "connector" ? p.tools.providers(s.id).map((c) => c.manifest.id) : [];
    const dp = t.kind === "connector" ? t.connector.manifest.defaultPermissions ?? null : null;
    rows.push({
      id: s.id,
      kind: t.kind,
      source: s.source,
      providers,
      sideEffect: s.sideEffect,
      verb: s.verb,
      approval: s.approval ?? null,
      undo: s.undo ?? null,
      entity: s.entity ?? null,
      handlerKind,
      inZ,
      outZ,
      beforeZ,
      dp,
      testOutput: t.kind === "connector" ? typeof (t.connector.tools[s.id] as { testOutput?: unknown })?.testOutput === "function" : null,
    });
    // extra providers
    for (const c of p.tools.providers(s.id).slice(1)) {
      const h = c.tools[s.id];
      rows.push({ id: s.id, kind: "connector-alt", source: c.manifest.id, sideEffect: s.sideEffect, verb: s.verb, handlerKind: h?.kind, inZ: h?.input instanceof z.ZodType, outZ: h?.output instanceof z.ZodType, beforeZ: h?.kind === "write" ? h.beforeSchema instanceof z.ZodType : null, dp: c.manifest.defaultPermissions ?? null });
    }
  }
  const skills = p.catalog.list().map((s) => ({ id: s.id, mode: s.mode, handler: (s as { handler?: string }).handler ?? null, tools: s.tools, category: s.category, requiresPacks: (s as { requiresPacks?: string[] }).requiresPacks ?? null, requiresConnectors: (s as {requiresConnectors?: string[]}).requiresConnectors ?? null, hasInput: Boolean(s.input), hasOutput: Boolean(s.output) }));
  writeFileSync(process.env.DUMP_OUT ?? "/tmp/dump.json", JSON.stringify({ tools: rows, skills, connectors: p.connectors.list().map((c) => ({ id: c.manifest.id, dp: c.manifest.defaultPermissions ?? null })) }, null, 1));
});
