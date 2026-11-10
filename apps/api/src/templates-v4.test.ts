// R9 (docs/plan.md §1.86, §9): the seeds and the pack templates saved as v4 versions. Each v4
// version is what core's converter reads its v3 version as, with the platform's own registries (so
// tool skills became read and write steps by their tool's side effect), every id kept; it passes
// `validateAnyBundle` against the platform; the skills it names are registered (R2: the seeds' four
// unregistered names are gone) and none is a tool wrapper (they retire). Then the installs: the
// platform-template route adds the seeded v4 versions with the seed's hash, once; switching a pack
// on installs its templates' v2 where v1 is installed already and on a fresh install, once.

import { convertLookup } from "@countersign/agents";
import {
  createBankfeedConnector,
  createQboConnector,
  generateEncryptionKey,
} from "@countersign/connectors";
import { FAKE_PLAID, FAKE_QBO_CLIENT, fakePlaid, fakeQbo } from "@countersign/connectors/testing";
import {
  type AgentBundle,
  type AnyAgentBundle,
  isToolWrapper,
  parseSkillRef,
  processes,
  type Workflow,
} from "@countersign/core";
import { agent, agentVersion } from "@countersign/db";
import {
  loadDemoAgent,
  loadDemoAgentVersions,
  loadSeedTemplates,
  loadSeedVersions,
} from "@countersign/db/seed";
import { knownModelIds } from "@countersign/llm";
import { bookkeepingManifest } from "@countersign/pack-bookkeeping";
import { marketingManifest } from "@countersign/pack-marketing";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { type ApiHarness, createApiHarness, OPERATOR } from "./api.test-helper";
import { createPlatform, deploymentConnectors } from "./platform";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

// The catalog a deployment builds (every connector registered, outside production).
const platform = createPlatform({ connectors: deploymentConnectors({}, false) });
const lookup = convertLookup(platform.catalog, platform.tools);
const ctx = {
  skills: Object.fromEntries(platform.catalog.list().map((s) => [s.id, s])),
  tools: platform.tools.specs(),
  events: platform.events.byType(),
  models: knownModelIds(),
};

interface Pair {
  name: string;
  v3: AgentBundle;
  v4: AnyAgentBundle;
}

/** Every v4 version with the v3 version it was read from. */
async function pairs(): Promise<Pair[]> {
  const out: Pair[] = [];
  const v1s = await loadSeedTemplates();
  const later = await loadSeedVersions();
  const seedAt = (slug: string, n: number) =>
    n === 1
      ? v1s.find((t) => t.slug === slug)?.bundle
      : (later.find((v) => v.slug === slug && v.version === n)?.bundle as AgentBundle | undefined);
  for (const [slug, from, to] of [
    ["bill-clerk", 1, 2],
    ["supervisor", 3, 4],
  ] as const) {
    const v3 = seedAt(slug, from);
    const v4 = later.find((v) => v.slug === slug && v.version === to)?.bundle;
    if (!v3 || !v4) throw new Error(`no ${slug} seed`);
    out.push({ name: `seed ${slug} v${to}`, v3, v4 });
  }
  const demo = await loadDemoAgent();
  const [demoV2] = await loadDemoAgentVersions();
  if (!demoV2) throw new Error("no demo v2");
  out.push({ name: "seed demo client agent v2", v3: demo.bundle, v4: demoV2.bundle });
  for (const m of [bookkeepingManifest, marketingManifest]) {
    for (const t of m.templates) {
      const [v2, ...more] = t.versions ?? [];
      expect(more, t.slug).toEqual([]);
      if (!v2) throw new Error(`${t.slug} has no v2`);
      out.push({ name: `${m.id} ${t.slug} v2`, v3: t.bundle, v4: v2 });
    }
  }
  return out;
}

const all = await pairs();

describe("the v4 versions of the seeds and pack templates", () => {
  it("cover every seeded and pack template that has a workflow", () => {
    expect(all.map((p) => p.name)).toEqual([
      "seed bill-clerk v2",
      "seed supervisor v4",
      "seed demo client agent v2",
      "bookkeeping bookkeeper v2",
      "marketing site-report v2",
      "marketing titles v2",
      "marketing article-drafts v2",
      "marketing forum-watch v2",
      "marketing social-posts v2",
    ]);
  });

  it.each(all)("$name is its v3 version as the converter reads it, every id kept", (p) => {
    // The definition is the v3 version's; only the workflows moved.
    expect(p.v4.definition).toEqual(p.v3.definition);
    expect(p.v4.workflows.map((w) => w.slug)).toEqual(p.v3.workflows.map((w) => w.slug));
    for (const w of p.v4.workflows) {
      const before = p.v3.workflows.find((x) => x.slug === w.slug)?.workflow as Workflow;
      const up = processes.upgradeWorkflowV3(before, lookup);
      // Nothing of v3 is left behind (no conversation lost a field).
      expect(up.dropped, w.slug).toEqual({});
      expect(w.workflow, w.slug).toEqual(processes.Process.parse(up.process));
      if (w.workflow.schemaVersion !== 4) throw new Error(`${w.slug}: not v4`);
      // The converter's id check: the same ids, in the same order (merges line up by them).
      const v3Ids = processes.nodeIds(processes.fromWorkflowV3(before, lookup));
      expect(processes.nodeIds(w.workflow), w.slug).toEqual(v3Ids);
    }
  });

  it.each(all)("$name passes validation against the platform, approval on", (p) => {
    const r = processes.validateAnyBundle(p.v4, ctx);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    for (const w of p.v4.workflows) {
      if (w.workflow.schemaVersion !== 4) throw new Error("not v4");
      for (const { step } of processes.allSteps(w.workflow)) {
        const loose = processes.approvalLoosenings(step.checks?.approval, "checks.approval");
        expect(loose, step.id).toEqual([]);
        // A write to a client's tool says so, with approval required (invariant 8).
        if (step.kind === "write" && ctx.tools[step.tool]?.sideEffect === "external") {
          expect(step.checks?.approval?.required, step.id).toBe("required");
        }
        // A skill step thinks: it never names a skill that only wraps a tool (R2 retires them).
        if (step.kind === "skill") {
          const def = ctx.skills[parseSkillRef(step.skill).id];
          expect(def && !isToolWrapper(def), step.id).toBe(true);
        }
      }
    }
  });
});

describe("R2: the skills the latest seeds and templates name", () => {
  it("are all registered: the four names nothing registers are gone", async () => {
    const latest = new Map<string, AnyAgentBundle>();
    for (const t of await loadSeedTemplates()) latest.set(t.slug, t.bundle);
    for (const v of await loadSeedVersions()) latest.set(v.slug, v.bundle);
    for (const m of [bookkeepingManifest, marketingManifest]) {
      for (const t of m.templates) latest.set(t.slug, t.versions?.at(-1) ?? t.bundle);
    }
    const missing = [...latest].flatMap(([slug, b]) =>
      b.definition.skills
        .map((s) => parseSkillRef(s.skill).id)
        .filter((id) => !platform.catalog.get(id))
        .map((id) => `${slug}: ${id}`),
    );
    expect(missing).toEqual([]);
    // The v1s still name them (stored history is never edited).
    const v1Missing = (await loadSeedTemplates()).flatMap((t) =>
      t.bundle.definition.skills
        .map((s) => parseSkillRef(s.skill).id)
        .filter((id) => !platform.catalog.get(id)),
    );
    expect(v1Missing.sort()).toEqual([
      "agents.review",
      "agents.route-ask",
      "builder.draft-agent",
      "builder.revise-agent",
    ]);
  });

  // DECISION (R2): every tool-mode built-in only wraps its tool, so `isToolWrapper` is the mark the
  // builder and the Library read a retired skill by; no field of its own is needed.
  it("mark every tool-mode skill as retired by `isToolWrapper`, and nothing else", () => {
    const builtins = platform.catalog.list();
    expect(builtins.filter((s) => s.mode === "tool")).toEqual(builtins.filter(isToolWrapper));
  });
});

// ── The installs ──────────────────────────────────────────────────────────────────────────────

const qbo = fakeQbo();
const h = await createApiHarness({
  connectors: () => [
    createQboConnector({
      ...FAKE_QBO_CLIENT,
      environment: "sandbox",
      webhookVerifier: "qbo-verifier",
      fetch: qbo.fetch,
      sleep: async () => {},
    }),
    createBankfeedConnector({ ...FAKE_PLAID, fetch: fakePlaid().fetch }),
  ],
  env: {
    ENCRYPTION_KEY: generateEncryptionKey(),
    OAUTH_STATE_SECRET: "state-secret-".repeat(4),
    APP_ORIGIN: "https://app.mezonas.test",
    QBO_WEBHOOK_VERIFIER: "qbo-verifier",
  },
});
afterAll(() => h?.close());

describe.skipIf(!h)("installing the v4 versions", () => {
  const H = h as ApiHarness;

  async function versionsOf(slug: string) {
    const [tpl] = await H.t.db
      .select()
      .from(agent)
      .where(and(isNull(agent.tenantId), eq(agent.slug, slug)));
    if (!tpl) return { live: null, versions: [] };
    const versions = await H.t.db
      .select()
      .from(agentVersion)
      .where(eq(agentVersion.agentId, tpl.id))
      .orderBy(agentVersion.version);
    return { live: tpl.liveVersionId, versions };
  }

  it("adds each seeded v4 version from the back office, with the seed's hash, once", async () => {
    const later = await loadSeedVersions();
    for (const [slug, version] of [
      ["bill-clerk", 2],
      ["builder", 2],
      ["coordinator", 2],
      ["supervisor", 4],
    ] as const) {
      const seeded = later.find((v) => v.slug === slug && v.version === version);
      const path = `/api/ops/platform-templates/${slug}/install`;
      const res = await H.call(OPERATOR, "POST", path, { version });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(j(res.json)).toMatchObject({ version: { status: "live" }, installed: true });
      const { live, versions } = await versionsOf(slug);
      const row = versions.find((v) => v.id === live);
      expect(row?.bundleHash, slug).toBe(seeded?.hash);
      // A template missing here starts from its v1, so v4 lands on top of it.
      expect(versions[0]?.version).toBe(1);
      const again = await H.call(OPERATOR, "POST", path, { version });
      expect(j(again.json)).toMatchObject({ version: j(res.json).version, installed: false });
    }
  });

  it("adds the Bookkeeper's v2 where its v1 is installed already, and live", async () => {
    // As the pack's first install left it: v1 only, published.
    const v1 = bookkeepingManifest.templates[0];
    if (!v1) throw new Error("no bookkeeper");
    const made = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: v1.slug,
      bundle: v1.bundle,
    });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${j(made.json).agent.id}/versions/${j(made.json).version.id}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);

    const enable = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${H.A.tenantId}/packs/bookkeeping/enable`,
    );
    expect(enable.status, JSON.stringify(enable.json)).toBe(200);
    expect(j(enable.json).installed).toEqual([
      { slug: "bookkeeper", templateId: j(made.json).agent.id },
    ]);
    const { live, versions } = await versionsOf("bookkeeper");
    expect(versions.map((v) => [v.version, v.status, v.authorType])).toEqual([
      [1, "retired", "operator"],
      [2, "live", "pack"],
    ]);
    expect(live).toBe(versions[1]?.id);
    const v2 = versions[1]?.bundle as AnyAgentBundle | undefined;
    expect(v2?.workflows.map((w) => w.workflow.schemaVersion)).toEqual([4, 4, 4, 4]);

    // Switching it on again (or for another client) adds nothing.
    for (const client of [H.A.tenantId, H.B.tenantId]) {
      const again = await H.call(
        OPERATOR,
        "POST",
        `/api/ops/clients/${client}/packs/bookkeeping/enable`,
      );
      expect(again.status, JSON.stringify(again.json)).toBe(200);
      expect(j(again.json).installed).toEqual([]);
    }
    expect((await versionsOf("bookkeeper")).versions).toHaveLength(2);
  });

  it("installs the marketing agents fresh as v1 then v2, v2 live", async () => {
    const enable = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${H.A.tenantId}/packs/marketing/enable`,
    );
    expect(enable.status, JSON.stringify(enable.json)).toBe(200);
    const slugs = marketingManifest.templates.map((t) => t.slug);
    expect(j(enable.json).installed.map((i: { slug: string }) => i.slug)).toEqual(slugs);
    for (const t of marketingManifest.templates) {
      const { live, versions } = await versionsOf(t.slug);
      expect(
        versions.map((v) => [v.version, v.status]),
        t.slug,
      ).toEqual([
        [1, "retired"],
        [2, "live"],
      ]);
      expect(live).toBe(versions[1]?.id);
    }
    const again = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${H.A.tenantId}/packs/marketing/enable`,
    );
    expect(j(again.json).installed).toEqual([]);
  });

  it("forks a v4 template into a client, and its run forms read the v4 triggers", async () => {
    const [tpl] = await H.t.db
      .select()
      .from(agent)
      .where(and(isNull(agent.tenantId), eq(agent.slug, "bookkeeper")));
    const fork = await H.call(OPERATOR, "POST", `/api/ops/templates/${tpl?.id}/fork`, {
      clientId: H.A.tenantId,
      slug: "bookkeeper-a",
    });
    expect(fork.status, JSON.stringify(fork.json)).toBe(200);
    const [row] = await H.t.db
      .select()
      .from(agentVersion)
      .where(eq(agentVersion.id, j(fork.json).version.id));
    expect(row?.basedOnTemplateVersionId).toBe(tpl?.liveVersionId);
    const forked = row?.bundle as AnyAgentBundle | undefined;
    expect(forked?.workflows[0]?.workflow.schemaVersion).toBe(4);
  });
});
