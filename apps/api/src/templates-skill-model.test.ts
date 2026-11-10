// Skill model (2026-11-10; ARCHITECTURE §10.14, docs/plan.md §1.86 "Skill model"): the template
// versions built from it. Each seeded and pack template that used a retired kind of skill (agent
// mode, a task skill whose tools write, a tool wrapper) has a new version built from AI skills,
// deterministic skills, read steps and write steps: it validates against the platform as a
// template, names no retired skill, keeps approval on every change to a client's tool, and sets
// the cheap model on its reading skills. Then the installs: the seeded versions load and install
// once, a pack's update adds its new version and a fork is offered it (never moved: invariant 11),
// and a fork of each new version publishes for a client with QuickBooks bound (and the Bill
// clerk's Create bill for a client with BILL bound as well).

import { createTemplate, createVersion, publish } from "@countersign/agents";
import {
  createBankfeedConnector,
  createBillcomConnector,
  createHackerNewsConnector,
  createLinkedInConnector,
  createQboConnector,
  createWebsiteConnector,
  generateEncryptionKey,
  MemoryObjectStore,
} from "@countersign/connectors";
import {
  FAKE_BILLCOM,
  FAKE_PLAID,
  FAKE_QBO_CLIENT,
  FAKE_QBO_REALM,
  fakeBillcom,
  fakePlaid,
  fakeQbo,
} from "@countersign/connectors/testing";
import {
  type AnyAgentBundle,
  cloneJson,
  isToolWrapper,
  parseSkillRef,
  processes,
  routes,
  skillKind,
  toolLookup,
} from "@countersign/core";
import { agent, agentVersion, connection, withOperator } from "@countersign/db";
import { loadSeedTemplates, loadSeedVersions } from "@countersign/db/seed";
import { DEFAULT_MODELS, knownModelIds } from "@countersign/llm";
import { bookkeepingManifest } from "@countersign/pack-bookkeeping";
import { marketingManifest } from "@countersign/pack-marketing";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { latestSeededVersion } from "./account/templates";
import { type ApiHarness, admin, createApiHarness, OPERATOR } from "./api.test-helper";
import { createPlatform, deploymentConnectors } from "./platform";
import { stepTools } from "./routes/ops-lineage";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

/** The AI skills that read (a document, items for lines): the cheap model. */
const READING = new Set([
  "docs.read-document",
  "bookkeeping.read-statement-document",
  "qbo.choose-invoice-lines",
]);

// The catalog a deployment builds (every connector registered, outside production).
const platform = createPlatform({ connectors: deploymentConnectors({}, false) });
const ctx = {
  skills: Object.fromEntries(platform.catalog.list().map((s) => [s.id, s])),
  tools: platform.tools.specs(),
  events: platform.events.byType(),
  models: knownModelIds(),
};
const lookup = toolLookup(platform.tools.specs());

interface Built {
  name: string;
  bundle: AnyAgentBundle;
}

/** The skill-model versions: the seeds' latest, and each pack template's latest. */
async function built(): Promise<Built[]> {
  const later = await loadSeedVersions();
  const seed = (slug: string, version: number) => {
    const v = later.find((x) => x.slug === slug && x.version === version);
    if (!v) throw new Error(`no seed ${slug} v${version}`);
    return { name: `seed ${slug} v${version}`, bundle: v.bundle };
  };
  const out: Built[] = [seed("bill-clerk", 3), seed("document-clerk", 2), seed("supervisor", 5)];
  for (const m of [bookkeepingManifest, marketingManifest]) {
    for (const t of m.templates) {
      const versions = t.versions ?? [];
      const latest = versions.at(-1);
      if (!latest) throw new Error(`${t.slug} has no later version`);
      out.push({ name: `${m.id} ${t.slug} v${versions.length + 1}`, bundle: latest });
    }
  }
  return out;
}

const all = await built();

/** Every step of a bundle's v4 processes. */
function stepsOf(b: AnyAgentBundle): processes.Step[] {
  return b.workflows.flatMap((w) =>
    w.workflow.schemaVersion === 4 ? processes.allSteps(w.workflow).map((l) => l.step) : [],
  );
}

describe("the skill model's template versions", () => {
  it("cover the seeded and pack templates that used a retired kind of skill", () => {
    expect(all.map((b) => b.name)).toEqual([
      "seed bill-clerk v3",
      "seed document-clerk v2",
      "seed supervisor v5",
      "bookkeeping bookkeeper v3",
      "marketing site-report v3",
      "marketing titles v3",
      "marketing article-drafts v3",
      "marketing forum-watch v3",
      "marketing social-posts v3",
    ]);
  });

  // DECISION: three of them carry the validator's advice to split (never an error): the Bill
  // clerk's process (25 steps with its new bill path), the Bookkeeper's daily process (23, with
  // the proposals' own steps) and the forum watch (a thread's reply four levels in). Splitting
  // them is the one-process-per-agent work (docs/plan.md §1.86), not this version's.
  const ADVICE: Record<string, string[]> = {
    "seed bill-clerk v3": ["split_long"],
    "bookkeeping bookkeeper v3": ["split_long"],
    "marketing forum-watch v3": ["split_deep"],
  };

  it.each(all)("$name validates against the platform as a template", (b) => {
    const r = processes.validateAnyBundle(b.bundle, ctx);
    expect(r.errors).toEqual([]);
    expect(r.warnings.map((w) => w.code)).toEqual(ADVICE[b.name] ?? []);
    for (const w of b.bundle.workflows) expect(w.workflow.schemaVersion, w.slug).toBe(4);
  });

  it.each(all)("$name names no retired kind of skill and keeps approval on changes", (b) => {
    for (const step of stepsOf(b.bundle)) {
      if (step.kind === "skill") {
        const def = ctx.skills[parseSkillRef(step.skill).id];
        expect(def, step.id).toBeDefined();
        if (!def) continue;
        expect(isToolWrapper(def), step.id).toBe(false);
        // Sloan's conversation is the one agent-mode skill kept (it is a conversation).
        if (def.id !== "account.chat") {
          expect(def.mode, `${step.id}: ${def.id}`).not.toBe("agent");
          expect(def.method, step.id).not.toBe("rules_then_ai");
        }
        // An AI skill writes nothing: its tools and reads only read.
        if (skillKind(def, lookup) === "ai" && def.id !== "account.chat") {
          for (const t of [...def.tools, ...(def.reads ?? [])]) {
            const side = ctx.tools[t]?.sideEffect;
            expect(side === "internal" || side === "external", `${def.id} ${t}`).toBe(false);
          }
        }
      }
      if (step.kind === "write") {
        const external =
          step.action !== undefined || ctx.tools[step.tool ?? ""]?.sideEffect === "external";
        if (external) expect(step.checks?.approval?.required, step.id).toBe("required");
        expect(
          processes.approvalLoosenings(step.checks?.approval, "checks.approval"),
          step.id,
        ).toEqual([]);
      }
    }
    // Every skill the processes use is the agent's; no tool wrapper is left among them.
    const listed = new Set(b.bundle.definition.skills.map((s) => parseSkillRef(s.skill).id));
    for (const step of stepsOf(b.bundle)) {
      if (step.kind === "skill")
        expect(listed.has(parseSkillRef(step.skill).id), step.id).toBe(true);
    }
    for (const id of listed) {
      const def = ctx.skills[id];
      expect(def && !isToolWrapper(def), id).toBe(true);
    }
  });

  // DECISION: the reading skills (a document read, items chosen for lines) run on the cheap model,
  // set on the agent's skill so the builder shows "the agent's"; analysis runs on the skill's own.
  it.each(all)("$name sets the cheap model on its reading skills", (b) => {
    for (const s of b.bundle.definition.skills) {
      if (READING.has(parseSkillRef(s.skill).id)) {
        expect(s.model?.id, s.skill).toBe(DEFAULT_MODELS.classification);
      }
    }
  });
});

// ── The installs, the update offer, and fork + publish for a client ───────────────────────────

const qbo = fakeQbo();
const bill = fakeBillcom();
const h = await createApiHarness({
  connectors: () => [
    createQboConnector({
      ...FAKE_QBO_CLIENT,
      environment: "sandbox",
      fetch: qbo.fetch,
      sleep: async () => {},
    }),
    createBillcomConnector({ devKey: FAKE_BILLCOM.devKey, fetch: bill.fetch }),
    createBankfeedConnector({ ...FAKE_PLAID, fetch: fakePlaid().fetch }),
    createWebsiteConnector({ store: new MemoryObjectStore() }),
    createHackerNewsConnector({
      fetch: async () => {
        throw new Error("no network in tests");
      },
    }),
    createLinkedInConnector({}),
  ],
  env: {
    ENCRYPTION_KEY: generateEncryptionKey(),
    OAUTH_STATE_SECRET: "state-secret-".repeat(4),
    APP_ORIGIN: "https://app.mezonas.test",
  },
});
afterAll(() => h?.close());

describe.skipIf(!h)("installing, offering and publishing the skill model's versions", () => {
  const H = h as ApiHarness;
  const conn = { qbo: "", billcom: "", website: "", linkedin: "", hackernews: "" };

  async function templateOf(slug: string) {
    const [tpl] = await H.t.db
      .select()
      .from(agent)
      .where(and(isNull(agent.tenantId), eq(agent.slug, slug)));
    if (!tpl) throw new Error(`no template ${slug}`);
    const versions = await H.t.db
      .select()
      .from(agentVersion)
      .where(eq(agentVersion.agentId, tpl.id))
      .orderBy(agentVersion.version);
    return { tpl, versions };
  }

  /** Forks a template version into client A, binds it and publishes it; answers the publish. */
  async function forkAndPublish(
    templateId: string,
    slug: string,
    bindings: Record<string, string>,
    versionId?: string,
  ) {
    const fork = await H.call(OPERATOR, "POST", `/api/ops/templates/${templateId}/fork`, {
      clientId: H.A.tenantId,
      slug,
      ...(versionId ? { versionId } : {}),
    });
    expect(fork.status, JSON.stringify(fork.json)).toBe(200);
    const id = j(fork.json).agent.id as string;
    const version = j(fork.json).version.id as string;
    await H.t.db.update(agent).set({ bindings }).where(eq(agent.id, id));
    const pub = await H.call(OPERATOR, "POST", `/api/ops/agents/${id}/versions/${version}/publish`);
    return { id, version, pub };
  }

  /** A connection of A's to `connector`, connected (as the marketing tests make them). */
  async function connect(connector: string) {
    const [c] = await H.t.db
      .insert(connection)
      .values({ tenantId: H.A.tenantId, connector, status: "connected", config: {} })
      .returning();
    return c?.id as string;
  }

  beforeAll(async () => {
    await H.call(OPERATOR, "PUT", `/api/ops/clients/${H.A.tenantId}/connectors`, {
      offered: ["testkit", "qbo", "billcom"],
    });
    const start = await H.call(admin("a"), "POST", "/api/connections/qbo/authorize");
    const state = new URL(j(start.json).redirectUrl).searchParams.get("state") ?? "";
    const done = await H.call(admin("a"), "POST", "/api/connections/qbo/callback", {
      params: { code: "fixture-code", state, realmId: FAKE_QBO_REALM },
    });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    conn.qbo = j(done.json).connection.connection.id;
    await H.settle();
    const vault = await H.call(admin("a"), "PUT", "/api/connections/billcom/credentials", {
      values: {
        username: FAKE_BILLCOM.username,
        password: FAKE_BILLCOM.password,
        organizationId: FAKE_BILLCOM.organizationId,
      },
    });
    expect(vault.status, JSON.stringify(vault.json)).toBe(200);
    conn.billcom = routes.portalSetCredentials.response.parse(vault.json).item.connectionId;
    conn.website = await connect("website");
    conn.linkedin = await connect("linkedin");
    conn.hackernews = await connect("hackernews");
  });

  it("loads the seeded versions with the seed's files, each after the one it extends", async () => {
    const later = await loadSeedVersions();
    const latest = (slug: string) =>
      Math.max(...later.filter((v) => v.slug === slug).map((v) => v.version));
    expect(latest("bill-clerk")).toBe(3);
    expect(latest("document-clerk")).toBe(2);
    expect(latest("supervisor")).toBe(5);
    expect(latestSeededVersion("bill-clerk")).toBe(3);
    expect(latestSeededVersion("document-clerk")).toBe(2);
    expect(latestSeededVersion("supervisor")).toBe(5);
    // The v1s are as they were (stored history is never edited).
    const v1 = (await loadSeedTemplates()).map((t) => t.slug);
    expect(v1).toEqual(["bill-clerk", "builder", "coordinator", "document-clerk", "supervisor"]);
  });

  it("installs the Bill clerk's v3 over v2 and offers it to a fork of v2, which doesn't move", async () => {
    const install = (version: number) =>
      H.call(OPERATOR, "POST", "/api/ops/platform-templates/bill-clerk/install", { version });
    expect((await install(2)).status).toBe(200);
    const before = await templateOf("bill-clerk");
    const fork = await forkAndPublish(before.tpl.id, "bill-clerk-v2", { qbo: conn.qbo });
    expect(fork.pub.status, JSON.stringify(fork.pub.json)).toBe(200);

    const res = await install(3);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(j(res.json)).toMatchObject({ version: { status: "live" }, installed: true });
    const seeded = (await loadSeedVersions()).find(
      (v) => v.slug === "bill-clerk" && v.version === 3,
    );
    const { tpl, versions } = await templateOf("bill-clerk");
    expect(versions.find((v) => v.id === tpl.liveVersionId)?.bundleHash).toBe(seeded?.hash);
    expect(j((await install(3)).json).installed).toBe(false);

    const usedBy = await H.call(OPERATOR, "GET", `/api/ops/templates/${tpl.id}/used-by`);
    expect(usedBy.status, JSON.stringify(usedBy.json)).toBe(200);
    const entry = j(usedBy.json).agents.find(
      (x: { agent: { id: string } }) => x.agent.id === fork.id,
    );
    expect(entry).toMatchObject({ baseVersion: 2, behind: 1 });
    const [mine] = await H.t.db
      .select()
      .from(agentVersion)
      .where(eq(agentVersion.agentId, fork.id));
    expect(JSON.stringify(mine?.bundle)).toContain("qbo.map-invoice-lines");
  });

  it("publishes a fork of the Bill clerk's v3 for a client with QuickBooks bound", async () => {
    const { tpl } = await templateOf("bill-clerk");
    const fork = await forkAndPublish(tpl.id, "bill-clerk-qbo", { qbo: conn.qbo });
    expect(fork.pub.status, JSON.stringify(fork.pub.json)).toBe(200);
  });

  it("asks which system Create bill uses when BILL is bound too, and publishes once it says", async () => {
    const { tpl } = await templateOf("bill-clerk");
    const both = { qbo: conn.qbo, billcom: conn.billcom };
    const fork = await forkAndPublish(tpl.id, "bill-clerk-bill", both);
    expect(fork.pub.status).toBe(422);
    expect(JSON.stringify(fork.pub.json)).toContain("action_needs_via");
    // The operator says BILL on the Create bill step, as a new version of the client's agent.
    const [row] = await H.t.db.select().from(agentVersion).where(eq(agentVersion.id, fork.version));
    const bundle = cloneJson(row?.bundle) as unknown as AnyAgentBundle;
    const w = bundle.workflows[0]?.workflow;
    if (w?.schemaVersion !== 4) throw new Error("v4 expected");
    const create = processes.findStep(w, "create")?.step;
    if (create?.kind !== "write") throw new Error("no create step");
    create.via = "billcom";
    const saved = await H.call(OPERATOR, "POST", `/api/ops/agents/${fork.id}/versions`, {
      bundle,
      parentVersionId: fork.version,
    });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    expect(j(saved.json).errors).toEqual([]);
    const id = j(saved.json).version.id as string;
    const pub = await H.call(OPERATOR, "POST", `/api/ops/agents/${fork.id}/versions/${id}/publish`);
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
  });

  it("installs the Document clerk's v2 and publishes a fork of it", async () => {
    const res = await H.call(
      OPERATOR,
      "POST",
      "/api/ops/platform-templates/document-clerk/install",
      {
        version: 2,
      },
    );
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const { tpl, versions } = await templateOf("document-clerk");
    expect(versions.map((v) => [v.version, v.status])).toEqual([
      [1, "retired"],
      [2, "live"],
    ]);
    const fork = await forkAndPublish(tpl.id, "document-clerk-a", { qbo: conn.qbo });
    expect(fork.pub.status, JSON.stringify(fork.pub.json)).toBe(200);
  });

  it("installs Sloan's v5 and publishes the client's account agent from it", async () => {
    const res = await H.call(OPERATOR, "POST", "/api/ops/platform-templates/supervisor/install", {
      version: 5,
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const { tpl, versions } = await templateOf("supervisor");
    const live = versions.find((v) => v.id === tpl.liveVersionId);
    expect(live?.version).toBe(versions.at(-1)?.version);
    // Sloan keeps its four processes (the owner's exception to one agent, one process).
    expect(live?.bundle.workflows.map((w) => w.slug)).toEqual([
      "run-failed",
      "connection-needs-attention",
      "daily-check",
      "chat",
    ]);
    const added = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/supervisor`, {});
    expect(added.status, JSON.stringify(added.json)).toBe(200);
    const [sloan] = await H.t.db
      .select()
      .from(agent)
      .where(and(eq(agent.tenantId, H.A.tenantId), eq(agent.slug, "supervisor")));
    if (!sloan) throw new Error("no account agent");
    // Adding the account agent publishes it (publishing's checks passed), from v5.
    const [version] = await H.t.db
      .select()
      .from(agentVersion)
      .where(eq(agentVersion.agentId, sloan.id));
    expect(version?.status).toBe("live");
    expect(sloan.liveVersionId).toBe(version?.id);
    expect(version?.basedOnTemplateVersionId).toBe(live?.id);
    expect(JSON.stringify(version?.bundle)).toContain("supervisor.explain");
  });

  it("gives the Bookkeeper its v3 by Update templates over v2, offered to a fork of v2", async () => {
    const t = bookkeepingManifest.templates[0];
    const [v2] = t?.versions ?? [];
    if (!t || !v2) throw new Error("no bookkeeper v2");
    // As staging has it: v1 and v2, the pack's, v2 live.
    const tpl = await withOperator(H.db, [H.A.tenantId], async (tx) => {
      const made = await createTemplate(tx, { slug: t.slug, bundle: t.bundle, authorType: "pack" });
      const second = await createVersion(tx, {
        agentId: made.agent.id,
        bundle: v2,
        authorType: "pack",
      });
      await publish(tx, { agentId: made.agent.id, versionId: second.id, ctx: H.platform.ctx });
      return made.agent;
    });
    const enable = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${H.A.tenantId}/packs/bookkeeping/enable`,
    );
    expect(enable.status, JSON.stringify(enable.json)).toBe(200);
    const old = await forkAndPublish(tpl.id, "bookkeeper-v2", { qbo: conn.qbo });
    expect(old.pub.status, JSON.stringify(old.pub.json)).toBe(200);

    const update = await H.call(OPERATOR, "POST", "/api/ops/packs/bookkeeping/templates/update");
    expect(update.status, JSON.stringify(update.json)).toBe(200);
    expect(j(update.json).updated).toEqual([
      { slug: "bookkeeper", templateId: tpl.id, version: 3, published: true },
    ]);
    const usedBy = await H.call(OPERATOR, "GET", `/api/ops/templates/${tpl.id}/used-by`);
    const entry = j(usedBy.json).agents.find(
      (x: { agent: { id: string } }) => x.agent.id === old.id,
    );
    expect(entry).toMatchObject({ baseVersion: 2, behind: 1 });

    const fork = await forkAndPublish(tpl.id, "bookkeeper-v3", { qbo: conn.qbo });
    expect(fork.pub.status, JSON.stringify(fork.pub.json)).toBe(200);
  });

  it("installs the marketing set's v3 on a fresh install and publishes a fork of each", async () => {
    const enable = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${H.A.tenantId}/packs/marketing/enable`,
    );
    expect(enable.status, JSON.stringify(enable.json)).toBe(200);
    for (const t of marketingManifest.templates) {
      const { tpl, versions } = await templateOf(t.slug);
      expect(
        versions.map((v) => [v.version, v.status]),
        t.slug,
      ).toEqual([
        [1, "retired"],
        [2, "retired"],
        [3, "live"],
      ]);
      const fork = await forkAndPublish(tpl.id, `${t.slug}-v3`, {
        website: conn.website,
        linkedin: conn.linkedin,
        hackernews: conn.hackernews,
      });
      expect(fork.pub.status, `${t.slug}: ${JSON.stringify(fork.pub.json)}`).toBe(200);
    }
  });
});

describe("the builder's palette and the new versions", () => {
  it("offers every tool their read and write steps call, a connector's under its connector", () => {
    const offered = new Set(stepTools(platform));
    const connectors = new Set(platform.connectors.list().map((c) => c.manifest.id));
    for (const b of all) {
      for (const id of processes.processTools(
        b.bundle.workflows.flatMap((w) => (w.workflow.schemaVersion === 4 ? [w.workflow] : [])),
      )) {
        const t = ctx.tools[id];
        expect(t, id).toBeDefined();
        if (!t) continue;
        const where = offered.has(id) || connectors.has(t.connector ?? t.source);
        expect(where, `${b.name}: ${id}`).toBe(true);
      }
    }
    // A conversation's and a reach-out's handlers stay steps of their own.
    expect(offered.has("comms.converse")).toBe(false);
  });
});
