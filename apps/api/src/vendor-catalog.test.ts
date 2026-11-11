// The vendor catalog (docs/plan.md §1.88). Without a database: the vendor-first skills are labelled
// (two deterministic, two AI), none writes, the split's Look up existing and Match the unmatched
// leave the palette (stored steps keep them), and the pattern validates. With one: the whole
// pattern runs through the workflow engine on one vendor's invoice (known SKU, known wording, a
// semantic hit, a line new to the vendor linked to a master item by the rules and one by the
// Master item manager, a new master item, a hard-rule veto that goes to a person), the person's
// answer is registered as an alias, and the vendor's next invoice is caught at step 2 with no model
// call. The model's answers and the embeddings are HAND-WRITTEN replays (fixtures/llm, marked
// `handWritten`): no API key here. Rebuild them after changing a prompt or the request's shape:
//   WRITE_SKILL_FIXTURES=1 COUNTERSIGN_REQUIRE_DB=1 pnpm --filter @countersign/api exec vitest run src/vendor-catalog.test.ts

import {
  AnyAgentBundle,
  type AnyAgentBundleInput,
  isToolWrapper,
  newSkillVersionProblems,
  newStepSkillReason,
  processes,
  skillKind,
  toolLookup,
} from "@countersign/core";
import {
  agent,
  appUser,
  auditEvent,
  docExtraction,
  docLine,
  document,
  stepRun,
  transaction,
  vendor,
} from "@countersign/db";
import {
  type EmbedRequest,
  fakeMessage,
  type LlmRequest,
  type LlmTransport,
  ReplayMissError,
  withRecording,
} from "@countersign/llm";
import { fileFixtureStore } from "@countersign/llm/node";
import {
  catalogItem,
  descriptionHash,
  itemAlias,
  itemMatch,
  masterText,
  normalize,
  parseLine,
  priceObservation,
  VENDOR_CATALOG_SKILLS,
  VENDOR_CATALOG_TOOLS,
  vendorCatalogProcess,
  vendorItem,
  vendorItemText,
} from "@countersign/pack-materials";
import { and, eq, like } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  FakeWorkflowStep,
  OPERATOR,
} from "./api.test-helper";
import { createPlatform, deploymentConnectors } from "./platform";
import { executeRun } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
type J = any;

const platform = createPlatform({ connectors: deploymentConnectors({}, false) });
const lookup = toolLookup(platform.tools.specs());

const KINDS = {
  "materials.match-vendor": "deterministic",
  "materials.match-sku-vendor": "deterministic",
  "materials.semantic-match-vendor": "ai",
  "materials.master-item-manager": "ai",
} as const;

function bundle(): AnyAgentBundleInput {
  return {
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name: "Purchasing clerk", role: "matches invoices", mission: "know what we buy" },
      kind: "functional",
      model: { id: "claude-sonnet-5-5", maxTokens: 1024 },
      instructions: "Match vendor invoice lines to the vendor's catalog.",
      skills: VENDOR_CATALOG_SKILLS.map((skill) => ({ skill })),
      extraTools: [...VENDOR_CATALOG_TOOLS],
      canCommand: [],
      permissions: { mode: "suggest_only" },
      budgets: { maxSteps: 4, maxCostUsd: "1.00" },
      memory: { enabled: false },
    },
    workflows: [
      { slug: "vendor-lines", name: "Match a vendor's invoice", workflow: vendorCatalogProcess() },
    ],
  } as unknown as AnyAgentBundleInput;
}

describe("the vendor-first skills on the platform", () => {
  it("labels each by its kind; none writes; each is offered for a new step", () => {
    for (const [id, kind] of Object.entries(KINDS)) {
      const def = platform.catalog.get(id);
      expect(def, id).toBeDefined();
      if (!def) continue;
      expect(skillKind(def, lookup), id).toBe(kind);
      expect(isToolWrapper(def), id).toBe(false);
      expect(newSkillVersionProblems(def, lookup), id).toEqual([]);
      expect(newStepSkillReason(def, lookup, platform.superseded), id).toBeNull();
    }
  });

  it("keeps Look up existing and Match the unmatched for stored steps, off the palette", () => {
    for (const [id, by] of [
      ["materials.lookup-existing", "materials.match-sku-vendor"],
      ["materials.match-unmatched", "materials.semantic-match-vendor"],
    ] as const) {
      const def = platform.catalog.get(id);
      expect(def, id).toBeDefined();
      if (def) expect(newStepSkillReason(def, lookup, platform.superseded)).toContain(by);
    }
    // Check matches is reused after each AI skill.
    const check = platform.catalog.get("materials.check-matches");
    expect(check && newStepSkillReason(check, lookup, platform.superseded)).toBeNull();
  });

  it("writes only through Save to records tools; the searches and the embedding say they use a model", () => {
    for (const id of [
      "materials.vendor_items.register",
      "materials.vendor_item.upsert",
      "materials.vendor_item.set_preferred",
      "materials.vendor_item.discontinue",
      "materials.embeddings.write",
    ]) {
      expect(platform.tools.get(id)?.spec.sideEffect, id).toBe("internal");
    }
    for (const id of [
      "materials.vendor.match",
      "materials.vendor_items.lookup",
      "materials.vendor_items.similar",
      "materials.master_items.candidates",
      "materials.vendor_items.list",
      "materials.vendor_items.for_item",
    ]) {
      expect(platform.tools.get(id)?.spec.sideEffect, id).toBe("none");
    }
    for (const id of [
      "materials.vendor_items.similar",
      "materials.master_items.candidates",
      "materials.embeddings.write",
      "materials.vendor_item.upsert",
    ]) {
      expect(platform.tools.get(id)?.spec.usesModel, id).toBeDefined();
    }
  });

  it("the pattern validates against the platform's registries", () => {
    const result = processes.validateAnyBundle(AnyAgentBundle.parse(bundle()), {
      skills: Object.fromEntries(platform.catalog.list().map((s) => [s.id, s])),
      tools: platform.tools.specs(),
      events: platform.events.byType(),
    });
    expect(result.errors).toEqual([]);
  });
});

// ── End to end ────────────────────────────────────────────────────────────────────────────────

const h = await createApiHarness();
afterAll(() => h?.close());

const WRITE = process.env.WRITE_SKILL_FIXTURES === "1";

/** A stand-in embedding: character trigrams hashed into 1,024 dimensions, unit length. */
function fakeEmbedding(text: string): number[] {
  const v = new Array<number>(1024).fill(0);
  const s = ` ${text.toLowerCase()} `;
  for (let i = 0; i + 3 <= s.length; i++) {
    let hash = 2166136261;
    for (const c of s.slice(i, i + 3)) {
      hash ^= c.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    v[(hash >>> 0) % 1024] = (v[(hash >>> 0) % 1024] ?? 0) + 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => Math.round((x / n) * 1e4) / 1e4);
}

// The ids the model's requests carry, fixed so the recorded answers replay.
const M = {
  baltic34: "0193f000-0000-7000-8000-0000000d0001",
  walnut: "0193f000-0000-7000-8000-0000000d0002",
  baltic12: "0193f000-0000-7000-8000-0000000d0003",
  melamine: "0193f000-0000-7000-8000-0000000d0004",
  oak: "0193f000-0000-7000-8000-0000000d0007",
};
const MASTERS: [string, string][] = [
  [M.baltic34, 'BALTIC BIRCH PLYWOOD 3/4" 5X5 BB/BB'],
  [M.walnut, "WALNUT 4/4 FAS"],
  [M.baltic12, 'BALTIC BIRCH 1/2" 5X5 BB/BB'],
  [M.melamine, 'MELAMINE 3/4" 4X8'],
  [M.oak, "WHITE OAK 8/4 FAS"],
];
const VI = {
  bb34: "0193f000-0000-7000-8000-0000000e0001",
  walnut: "0193f000-0000-7000-8000-0000000e0002",
};

type Line = [
  lineNo: number,
  sku: string | null,
  text: string,
  qty: string,
  uom: string,
  price: string,
];
const FIRST: Line[] = [
  [1, "BB34-55", 'Baltic Birch Plywood 3/4" 5x5 BB/BB', "40", "SHT", "68.50"], // known SKU
  [2, null, "WALNUT 4/4 FAS KD", "120", "BF", "9.80"], // known wording
  [3, null, "BB PLY 18MM 5X5", "10", "SHT", "66.00"], // semantic hit
  [4, null, 'BALTIC BIRCH PLY 1/2"', "12", "SHT", "51.00"], // a hard-rule veto: a person
  [5, null, "WHITE OAK 8/4 FAS", "80", "BF", "11.25"], // new to the vendor, linked by the rules
  [6, null, 'MELAMINE 3/4" 4X8 WHITE', "20", "SHT", "47.10"], // linked by the master item manager
  [7, null, "CHERRY 4/4 FAS", "60", "BF", "8.40"], // a new master item
];
const SECOND: Line[] = [
  [1, null, 'BALTIC BIRCH PLY 1/2"', "6", "SHT", "50.00"], // the person's answer, now an alias
  [2, "BB34-55", 'Baltic Birch Plywood 3/4" 5x5 BB/BB', "10", "SHT", "70.00"], // an older price
];

/** The task input of an AI skill's request (it follows the first blank line, as JSON). */
function taskInput(request: LlmRequest): { lines: J[] } {
  const first = request.messages[0]?.content;
  const block = Array.isArray(first) ? first.find((b) => b.type === "text") : undefined;
  const text = block && "text" in block ? block.text : "";
  return (JSON.parse(text.slice(text.indexOf("\n\n") + 2)) as { input: { lines: J[] } }).input;
}

/** Replay; writing, a miss is answered by hand (each line matched to its first candidate). */
function transportFor(calls: { create: number; embed: number }): LlmTransport {
  const store = fileFixtureStore();
  const replay = withRecording(null, { mode: "replay", store });
  const writer = withRecording(
    {
      async create(request: LlmRequest) {
        const { lines } = taskInput(request);
        const vendorLevel = lines.some((l) => l.candidates?.[0]?.vendorItemId);
        const answers = lines.map((l) => {
          const c = l.candidates[0];
          return {
            lineNo: l.lineNo,
            decision: c ? "matched" : "new_item",
            catalogItemId: c?.catalogItemId ?? null,
            ...(vendorLevel ? { vendorItemId: c?.vendorItemId ?? null } : {}),
            confidence: vendorLevel ? 0.95 : 0.93,
            hingeAttribute: null,
          };
        });
        return fakeMessage(
          request.model,
          [
            {
              type: "tool_use",
              id: `toolu_handwritten_${vendorLevel ? "semantic_vendor" : "master_manager"}`,
              name: "finish",
              input: { answers },
              caller: { type: "direct" },
            } as never,
          ],
          "tool_use",
          { input: 1200, output: 60 * answers.length + 40 },
        );
      },
      async embed(request: EmbedRequest) {
        return {
          model: "text-embedding-3-large",
          embeddings: request.input.map(fakeEmbedding),
          usage: { inputTokens: request.input.join(" ").length },
        };
      },
    },
    {
      mode: "record",
      store: {
        read: store.read,
        write: (call) => store.write({ ...call, handWritten: true }),
      },
    },
  );
  const orWrite = async <T>(a: () => Promise<T>, b: () => Promise<T>) => {
    try {
      return await a();
    } catch (error) {
      if (WRITE && error instanceof ReplayMissError) return b();
      throw error;
    }
  };
  return {
    create(request, options) {
      calls.create++;
      return orWrite(
        () => replay.create(request, options),
        () => writer.create(request, options),
      );
    },
    embed(request, options) {
      calls.embed++;
      return orWrite(
        () => (replay.embed as NonNullable<LlmTransport["embed"]>)(request, options),
        () => (writer.embed as NonNullable<LlmTransport["embed"]>)(request, options),
      );
    },
  };
}

describe.skipIf(!h)("the vendor catalog's pattern, end to end", () => {
  const H = h as ApiHarness;
  const tenantId = () => H.A.tenantId;
  let vendorId = "";
  let agentId = "";
  let versionId = "";
  let adminId = "";

  async function invoice(name: string, date: string, lines: Line[]): Promise<string> {
    const [bill] = await H.t.db
      .insert(transaction)
      .values({
        tenantId: tenantId(),
        kind: "bill",
        connector: "upload",
        vendorId,
        total: "1000.00",
        externalId: name,
      })
      .returning();
    const [doc] = await H.t.db
      .insert(document)
      .values({
        tenantId: tenantId(),
        transactionId: bill?.id ?? null,
        source: "upload",
        connectionId: H.A.connectionId,
        storageKey: `tenants/${tenantId()}/content/00/${name}`,
        mimeType: "application/pdf",
        filename: `${name}.pdf`,
        sizeBytes: 10,
        sha256: (await descriptionHash(name)).slice(0, 64),
      })
      .returning();
    const [x] = await H.t.db
      .insert(docExtraction)
      .values({
        tenantId: tenantId(),
        documentId: doc?.id ?? "",
        model: "test-model",
        header: { vendorName: "Northline Panel Supply", invoiceDate: date, invoiceNumber: name },
        subtotal: "1000",
        total: "1000",
        linesSum: "1000",
        totalsMatch: true,
      })
      .returning();
    await H.t.db.insert(docLine).values(
      lines.map(([lineNo, sku, text, qty, uom, price]) => ({
        tenantId: tenantId(),
        extractionId: x?.id ?? "",
        lineNo,
        vendorSku: sku,
        rawDescription: text,
        qty,
        uomRaw: uom,
        unitPrice: price,
        extPrice: (Number(price) * Number(qty)).toFixed(2),
      })),
    );
    return doc?.id ?? "";
  }

  /** Runs the pattern on a document; the person (the client's admin) answers with `answer`. */
  async function run(
    documentId: string,
    answer: unknown,
    calls: { create: number; embed: number },
  ) {
    const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/run`, {
      workflow: "vendor-lines",
      input: { documentId },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const params = H.instances.started.get((res.json as J).runId);
    if (!params) throw new Error("not started");
    const asked: J[] = [];
    await executeRun(
      { db: H.db, platform: H.platform, transport: transportFor(calls), instances: H.instances },
      params,
      cloudflareStepRunner(
        new FakeWorkflowStep(async (_name, type) => {
          const inbox = await H.call(admin("a"), "GET", "/api/inbox");
          const item = (inbox.json as J).items.find(
            (i: { id: string }) => `inbox-${i.id.replace(/-/g, "")}` === type,
          );
          if (!item) throw new Error(`no open item for ${type}`);
          asked.push(item);
          const done = await H.call(admin("a"), "POST", `/api/inbox/${item.id}/resolve`, {
            answer,
          });
          expect(done.status, JSON.stringify(done.json)).toBe(200);
          return H.instances.events.find((e) => e.event.type === type)?.event.payload;
        }),
      ),
    );
    const steps = await H.t.db.select().from(stepRun).where(eq(stepRun.runId, params.runId));
    const failed = steps.filter((s) => s.status === "failed");
    expect(failed.map((s) => `${s.nodeId}: ${JSON.stringify(s.output)}`)).toEqual([]);
    const out = (id: string): J => steps.find((s) => s.nodeId === id)?.output ?? null;
    return { steps, out, asked };
  }

  it("sets up a vendor with a catalog, and the client's master items", async () => {
    const enable = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${tenantId()}/packs/materials/enable`,
    );
    expect(enable.status, JSON.stringify(enable.json)).toBe(200);
    const [v] = await H.t.db
      .insert(vendor)
      .values({
        tenantId: tenantId(),
        name: "Northline Panel Supply",
        normalizedName: "northline panel supply",
      })
      .returning();
    vendorId = v?.id ?? "";
    for (const [id, text] of MASTERS) {
      const p = parseLine(text);
      await H.t.db.insert(catalogItem).values({
        id,
        tenantId: tenantId(),
        category: p.category,
        canonicalName: text,
        attributes: p.attributes,
        standardUom: p.standardUom,
        embedding: fakeEmbedding(
          masterText({ name: text, category: p.category, attributes: p.attributes }),
        ),
      } as never);
    }
    const items = [
      {
        id: VI.bb34,
        sku: "BB34-55",
        name: "BALTIC BIRCH PLY 3/4 5X5 BB/BB",
        master: M.baltic34,
        uom: "sheet",
      },
      { id: VI.walnut, sku: null, name: "WALNUT 4/4 FAS KD", master: M.walnut, uom: "board_foot" },
    ];
    for (const i of items) {
      const p = parseLine(MASTERS.find(([id]) => id === i.master)?.[1] ?? "");
      await H.t.db.insert(vendorItem).values({
        id: i.id,
        tenantId: tenantId(),
        vendorId,
        catalogItemId: i.master,
        sku: i.sku,
        name: i.name,
        vendorUom: i.uom,
        stdPerVendorUom: "1",
        embedding: fakeEmbedding(vendorItemText({ name: i.name, description: null }, p)),
      });
    }
    // The vendor's wording for the walnut, learned before.
    const wording = normalize("WALNUT 4/4 FAS KD");
    await H.t.db.insert(itemAlias).values({
      tenantId: tenantId(),
      vendorId,
      descriptionHash: await descriptionHash(wording),
      normalizedDescription: wording,
      catalogItemId: M.walnut,
      vendorItemId: VI.walnut,
      source: "human",
    });
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${tenantId()}/agents`, {
      slug: "purchasing-clerk",
      bundle: AnyAgentBundle.parse(bundle()),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    agentId = (created.json as J).agent.id;
    versionId = (created.json as J).version.id;
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${agentId}/versions/${versionId}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, agentId));
    const [u] = await H.t.db
      .select()
      .from(appUser)
      .where(eq(appUser.email, admin("a")));
    adminId = u?.id ?? "";
  });

  it("matches, vetoes, registers, and asks a person about the line nobody was sure of", async () => {
    const documentId = await invoice("NPS-1001", "2026-11-02", FIRST);
    const calls = { create: 0, embed: 0 };
    const { out, asked } = await run(
      documentId,
      { lines: [{ lineNo: 4, catalogItemId: M.baltic12 }] },
      calls,
    );
    // 1. The vendor, from the document's purchase.
    expect(out("vendor")).toMatchObject({ matched: true, vendorId, method: "document" });
    // 2. The SKU and the wording the vendor used before; nothing else was searched for them.
    expect(out("sku").known).toEqual([
      expect.objectContaining({
        lineNo: 1,
        vendorItemId: VI.bb34,
        catalogItemId: M.baltic34,
        via: "sku",
      }),
      expect.objectContaining({
        lineNo: 2,
        vendorItemId: VI.walnut,
        catalogItemId: M.walnut,
        via: "wording",
      }),
    ]);
    // 3. The rules settled the lines no item of the vendor's could be (new to it); the model the
    // other two, and the hard rules vetoed its answer for the 1/2" line.
    expect(out("similar").settled).toEqual([
      { lineNo: 5, decision: "new_item" },
      { lineNo: 6, decision: "new_item" },
      { lineNo: 7, decision: "new_item" },
    ]);
    expect(out("similar").open.map((l: J) => l.lineNo)).toEqual([3, 4]);
    const check = out("check").lines as J[];
    const byLine = (lines: J[], n: number) => lines.find((l) => l.lineNo === n);
    expect(byLine(check, 3)).toMatchObject({
      decision: "matched",
      method: "llm",
      catalogItemId: M.baltic34,
    });
    expect(byLine(check, 4)).toMatchObject({ decision: "unsure", needsReview: true });
    expect(byLine(check, 4).vetoed).toMatch(/differs/);
    // 4. The master item manager's read linked the oak by its key attributes; the model linked the
    // melamine; the cherry is new everywhere.
    expect(out("o-masters").open.map((l: J) => l.lineNo)).toEqual([6]);
    const resolved = out("o-check-masters").lines as J[];
    expect(byLine(resolved, 5)).toMatchObject({
      decision: "matched",
      method: "rules",
      catalogItemId: M.oak,
    });
    expect(byLine(resolved, 6)).toMatchObject({
      decision: "matched",
      method: "llm",
      catalogItemId: M.melamine,
    });
    expect(byLine(resolved, 7)).toMatchObject({ decision: "new_item", method: "rules" });
    // 5. Registered: six lines, one new master item, three new vendor items; the 1/2" for a person.
    const reg = out("o-m-register");
    expect(reg).toMatchObject({
      registered: 6,
      newMasterItems: 1,
      newVendorItems: 3,
      needsPersonCount: 1,
      anyNeedsPerson: true,
    });
    expect(reg.lines.find((l: J) => l.lineNo === 3)).toMatchObject({ vendorItemId: VI.bb34 });
    expect(reg.needsPerson[0]).toMatchObject({ lineNo: 4, description: 'BALTIC BIRCH PLY 1/2"' });
    expect(out("o-m-embed")).toMatchObject({ embedded: 4, catalogItems: 1, vendorItems: 3 });
    // 6. The person was asked, and their answer was registered as theirs.
    expect(asked).toHaveLength(1);
    expect(out("o-m-register-answer")).toMatchObject({ registered: 1, newVendorItems: 1 });
    expect(out("o-m-embed-answer")).toMatchObject({ embedded: 1, vendorItems: 1 });
    // Two AI calls (Semantic match, Master item manager); embeddings for the five lines not known,
    // the three lines new to the vendor, the new items, and the person's.
    expect(calls).toEqual({ create: 2, embed: 4 });

    // What was saved: every decided line by this agent version, the person's by the person.
    const matches = await H.t.db.select().from(itemMatch).where(eq(itemMatch.tenantId, tenantId()));
    const human = matches.filter((m) => m.method === "human");
    expect(human).toHaveLength(1);
    expect(human[0]).toMatchObject({ catalogItemId: M.baltic12, decidedByUserId: adminId });
    expect(
      matches
        .filter((m) => m.method !== "human" && m.decision !== "unsure")
        .every((m) => m.agentVersionId === versionId),
    ).toBe(true);
    // The cherry is a new, vendor-neutral master item, made by the agent version.
    const [cherry] = await H.t.db
      .select()
      .from(catalogItem)
      .where(and(eq(catalogItem.tenantId, tenantId()), like(catalogItem.canonicalName, "%herry%")));
    expect(cherry).toMatchObject({ category: "hardwood", createdByAgentVersionId: versionId });
    expect(cherry?.embedding).toHaveLength(1024);
    // Every price says which vendor item it was; the vendor item keeps the newest (the same day:
    // the later line).
    const prices = await H.t.db
      .select()
      .from(priceObservation)
      .where(eq(priceObservation.tenantId, tenantId()));
    expect(prices).toHaveLength(7);
    expect(prices.every((p) => p.vendorItemId !== null)).toBe(true);
    const [bb] = await H.t.db.select().from(vendorItem).where(eq(vendorItem.id, VI.bb34));
    expect(bb).toMatchObject({
      lastPrice: "66.0000",
      lastPriceStd: "66.0000",
      lastPriceOn: "2026-11-02",
      lastPriceSource: "invoice",
    });
    // The person's answer: a vendor item for the 1/2" Baltic birch, and its wording as a person's.
    const [half] = await H.t.db
      .select()
      .from(vendorItem)
      .where(and(eq(vendorItem.vendorId, vendorId), eq(vendorItem.catalogItemId, M.baltic12)));
    expect(half).toMatchObject({
      createdByUserId: adminId,
      lastPriceSource: "person",
      vendorUom: "sheet",
    });
    const [alias] = await H.t.db
      .select()
      .from(itemAlias)
      .where(
        eq(itemAlias.descriptionHash, await descriptionHash(normalize('BALTIC BIRCH PLY 1/2"'))),
      );
    expect(alias).toMatchObject({
      source: "human",
      vendorItemId: half?.id,
      catalogItemId: M.baltic12,
    });
  });

  it("catches the person's answer at step 2 next time, with no model call, and keeps the newer price", async () => {
    const documentId = await invoice("NPS-0990", "2026-10-20", SECOND);
    const calls = { create: 0, embed: 0 };
    const { out, asked } = await run(documentId, null, calls);
    expect(out("sku").openCount).toBe(0);
    expect(out("sku").known.map((k: J) => [k.lineNo, k.catalogItemId, k.via])).toEqual([
      [1, M.baltic12, "wording"],
      [2, M.baltic34, "sku"],
    ]);
    expect(out("s-r-register")).toMatchObject({ registered: 2, needsPersonCount: 0 });
    expect(asked).toEqual([]);
    expect(calls).toEqual({ create: 0, embed: 0 });
    // An older invoice never overwrites a newer last price.
    const [bb] = await H.t.db.select().from(vendorItem).where(eq(vendorItem.id, VI.bb34));
    expect(bb).toMatchObject({ lastPrice: "66.0000", lastPriceOn: "2026-11-02" });
  });

  it("serves the vendor's catalog and a master item's vendors to the operator, audited", async () => {
    const cat = await H.call(
      OPERATOR,
      "GET",
      `/api/ops/clients/${tenantId()}/reports/materials/vendor-catalog/items/${vendorId}`,
    );
    expect(cat.status, JSON.stringify(cat.json)).toBe(200);
    const items = (cat.json as J).report.items as J[];
    expect(items.map((i) => i.catalogItemId)).toContain(M.baltic12);
    expect(items.find((i) => i.id === VI.bb34)).toMatchObject({
      sku: "BB34-55",
      lastPrice: "66.0000",
    });
    const side = await H.call(
      OPERATOR,
      "GET",
      `/api/ops/clients/${tenantId()}/reports/materials/master-vendors/items/${M.baltic34}`,
    );
    expect(side.status, JSON.stringify(side.json)).toBe(200);
    expect((side.json as J).report.vendors.map((v: J) => v.id)).toEqual([VI.bb34]);
    // The portal doesn't read the back office's vendor catalog.
    const portal = await H.call(admin("a"), "GET", "/api/reports/materials/vendor-catalog");
    expect(portal.status).toBe(404);
    // Preferred, then discontinued: a person's actions, each with its audit row.
    const pref = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${tenantId()}/packs/materials/actions/vendor-item-preferred`,
      { vendorItemId: VI.bb34 },
    );
    expect(pref.status, JSON.stringify(pref.json)).toBe(200);
    expect((pref.json as J).result.item).toMatchObject({ preferred: true });
    const gone = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${tenantId()}/packs/materials/actions/vendor-item-discontinue`,
      { vendorItemId: VI.bb34 },
    );
    expect(gone.status, JSON.stringify(gone.json)).toBe(200);
    expect((gone.json as J).result.item).toMatchObject({
      status: "discontinued",
      preferred: false,
    });
    const again = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${tenantId()}/packs/materials/actions/vendor-item-preferred`,
      { vendorItemId: VI.bb34 },
    );
    expect(again.status).toBe(422);
    const audit = await H.t.db
      .select()
      .from(auditEvent)
      .where(like(auditEvent.action, "%/packs/:pack/actions/:action"));
    expect(audit.length).toBeGreaterThanOrEqual(2);
    // Another client's operator can't reach them.
    const other = await H.call(
      "other-operator@example.com",
      "GET",
      `/api/ops/clients/${tenantId()}/reports/materials/vendor-catalog/items/${vendorId}`,
    );
    expect([403, 404]).toContain(other.status);
  });
});
