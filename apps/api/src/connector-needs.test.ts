// Connectors C1 (docs/connectors-plan.md §4): what the platform's skills and every seeded and pack
// template need of a client's connections, worked out from their tools against the registries a
// deployment builds. Every built-in skill says what it needs (no connector named in
// `requiresConnectors` that its tools or `needs` don't cover), and every need names a registered
// connector, a registered tool and a record type its connector declares.

import { convertLookup } from "@countersign/agents";
import {
  type AgentBundle,
  AnyAgentBundle,
  agentNeeds,
  type ConnectorNeed,
  holdsStepModel,
  skillNeeds,
  toProcessBundle,
  uncoveredConnectors,
} from "@countersign/core";
import { loadDemoAgentVersions, loadSeedTemplates, loadSeedVersions } from "@countersign/db/seed";
import { describe, expect, it } from "vitest";
import { createPlatform, deploymentConnectors } from "./platform";

const platform = createPlatform({ connectors: deploymentConnectors({}, false) });
const lookup = convertLookup(platform.catalog, platform.tools);
const connectorIds = new Set(platform.connectors.list().map((c) => c.manifest.id));
const ctx = {
  skills: Object.fromEntries(platform.catalog.list().map((s) => [s.id, s])),
  tools: platform.tools.specs(),
  connectors: connectorIds,
};

/** Each seeded and pack template at its latest version, with the demo client agent. */
async function templates(): Promise<{ name: string; bundle: AgentBundle }[]> {
  const out: { name: string; bundle: AgentBundle }[] = [];
  const latest = new Map<string, { version: number; bundle: AgentBundle }>();
  for (const t of await loadSeedTemplates())
    latest.set(t.slug, { version: 1, bundle: t.bundle as AgentBundle });
  for (const v of await loadSeedVersions()) {
    const had = latest.get(v.slug);
    if (!had || v.version > had.version) {
      latest.set(v.slug, { version: v.version, bundle: v.bundle as AgentBundle });
    }
  }
  for (const [slug, v] of latest)
    out.push({ name: `seed ${slug} v${v.version}`, bundle: v.bundle });
  const demo = (await loadDemoAgentVersions()).at(-1);
  if (demo) out.push({ name: "seed demo client agent", bundle: demo.bundle as AgentBundle });
  for (const p of platform.packs) {
    for (const t of p.manifest.templates) {
      const last = (t.versions ?? []).at(-1) ?? t.bundle;
      out.push({ name: `${p.manifest.id} ${t.slug}`, bundle: last as AgentBundle });
    }
  }
  return out;
}

// The step model (the platform agents' seeds): a v5 workflow's needs are read from its steps as
// they are; older bundles through their v4 reading.
const all = (await templates()).map((t) => {
  const bundle = AnyAgentBundle.parse(t.bundle);
  return {
    ...t,
    needs: agentNeeds(holdsStepModel(bundle) ? bundle : toProcessBundle(bundle, lookup), ctx),
  };
});

/** A need as one line: `qbo create vendor (ask, via qbo.vendor.create)`. */
const line = (n: ConnectorNeed) =>
  [
    n.connector,
    n.verb,
    n.entity ?? "*",
    `(${n.level}${n.wantsAuto ? ", wants auto" : ""}${n.anyOf ? ", one of" : ""}${
      n.tool ? `, via ${n.tool}` : ""
    })`,
  ].join(" ");

function problems(needs: readonly ConnectorNeed[]): string[] {
  const out: string[] = [];
  for (const n of needs) {
    const connector = platform.connectors.get(n.connector);
    if (!connector) {
      out.push(`${line(n)}: no connector ${n.connector}`);
      continue;
    }
    if (n.tool && !ctx.tools[n.tool]) out.push(`${line(n)}: no tool ${n.tool}`);
    const declared = connector.manifest.permissionEntities;
    if (
      n.entity &&
      declared &&
      !declared.some((e) => e.id === n.entity && e.verbs.includes(n.verb))
    ) {
      out.push(`${line(n)}: ${n.connector} declares no ${n.verb} on ${n.entity}`);
    }
  }
  return out;
}

describe("what the platform's skills need", () => {
  const skills = platform.catalog.list();

  it("every built-in skill's connectors are covered by its tools or its needs", () => {
    const uncovered = skills
      .map((s) => [s.id, uncoveredConnectors(s, ctx)] as const)
      .filter(([, c]) => c.length > 0);
    expect(uncovered).toEqual([]);
  });

  it("every skill's need names a registered connector, tool and record type", () => {
    const bad = skills.flatMap((s) =>
      problems(
        skillNeeds(s, ctx).map((n) => ({
          ...n,
          level: n.verb === "read" ? "on" : "ask",
          wantsAuto: false,
          why: [],
          because: [],
        })),
      ).map((p) => `${s.id}: ${p}`),
    );
    expect(bad).toEqual([]);
  });
});

describe("what the templates need", () => {
  it("covers every seeded and pack template", () => {
    expect(all.length).toBeGreaterThanOrEqual(10);
  });

  it.each(all)("$name: every need names a registered connector, tool and record type", (t) => {
    expect(problems(t.needs)).toEqual([]);
  });

  it.each(all)("$name: no need asks for delete, and writes need at least ask", (t) => {
    expect(t.needs.filter((n) => n.verb === "delete")).toEqual([]);
    for (const n of t.needs) expect(n.level).toBe(n.verb === "read" ? "on" : "ask");
  });

  it("the Bill clerk's needs, read from its steps", () => {
    const clerk = all.find((t) => t.name.startsWith("seed bill-clerk"));
    expect(clerk?.needs.map(line).sort()).toMatchInlineSnapshot(`
      [
        "billcom create bill (ask, one of, via billcom.bill.create)",
        "qbo create attachment (ask, via qbo.attachable.upload)",
        "qbo create bill (ask, one of, via qbo.bill.create)",
        "qbo read account (on, via qbo.account.query)",
        "qbo read bill (on, via qbo.bill.query)",
        "qbo read item (on, via qbo.item.query)",
        "qbo read vendor (on, via qbo.vendor.query)",
        "qbo update bill (ask, via qbo.bill.update_lines)",
        "qbo update bill (ask, via qbo.bill.update_memo)",
      ]
    `);
  });
});
