// Packs on the platform (docs/plan.md §1.13, M8's done-when as far as it runs without a live model):
// the operator switches the Materials pack on for a client, which installs no agent (§1.63: agents
// are built in the Agent lab); an agent built from the pack's skills validates against the
// platform's registries; a client's own copy of it runs its purchase intake on an invoice the
// client uploaded (read from the recorded fixture) to priced lines with a price_jump alert, and the client sees it in Price watch (JSON and CSV); the back
// office sees the same; another client sees nothing; the match review card's decisions teach the
// catalog; client roles never reach the back office's pack routes.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEV_USER_HEADER } from "@countersign/auth";
import { ContentStore, findOrCreateVendor } from "@countersign/connectors";
import { FORBIDDEN_PORTAL_FIELD, validateBundle } from "@countersign/core";
import {
  agent,
  agentVersion,
  alert,
  docLine,
  inboxItem,
  stepRun,
  tenantPack,
  withTenant,
} from "@countersign/db";
import { DEFAULT_FIXTURE_DIR } from "@countersign/llm/node";
import {
  canonicalName,
  catalogItem,
  itemMatch,
  keySignature,
  parseLine,
  priceObservation,
} from "@countersign/pack-materials";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  FakeWorkflowStep,
  OPERATOR,
  user,
} from "./api.test-helper";
import { PURCHASING_TEST_BUNDLE } from "./purchasing.test-helper";
import { executeRun } from "./runs/execute";
import type { RunParams } from "./runs/instances";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
type J = any;

// A Worker's pool of one (`appDbMax: 1`): a route that opened a transaction beside the request's
// would wait on itself (a pack's action, a review's decision).
const h = await createApiHarness({ appDbMax: 1 });
afterAll(() => h?.close());

const FIXTURES = resolve(DEFAULT_FIXTURE_DIR, "..");
const invoicePdf = () => readFileSync(resolve(FIXTURES, "invoices", "northline-20418.pdf"));
const BB = 'Baltic Birch Plywood 3/4" 5x5 BB/BB';

/** Every key, at any depth, that a portal response may never carry (invariant 11). */
function forbiddenKeys(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) forbiddenKeys(v, found);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_PORTAL_FIELD.test(k)) found.push(k);
      forbiddenKeys(v, found);
    }
  }
  return found;
}

describe.skipIf(!h)("packs on the platform", () => {
  const H = h as ApiHarness;
  const pending: Promise<unknown>[] = [];

  /** A multipart upload as a client; waits for what the request deferred (reading, dispatch). */
  async function upload(email: string, files: { name: string; type: string; bytes: Uint8Array }[]) {
    const form = new FormData();
    for (const f of files) form.append("files", new File([f.bytes], f.name, { type: f.type }));
    const res = await H.app.request(
      "/api/uploads",
      { method: "POST", headers: { [DEV_USER_HEADER]: email }, body: form },
      H.env,
      {
        waitUntil: (p: Promise<unknown>) => void pending.push(p),
        passThroughOnException: () => {},
        props: {},
      } as unknown as ExecutionContext,
    );
    const json = (await res.json()) as J;
    while (pending.length > 0) await Promise.all(pending.splice(0));
    return { status: res.status, json };
  }

  it("lists the deployment's packs, with no templates, and each client's state", async () => {
    const res = await H.call(OPERATOR, "GET", "/api/ops/packs");
    expect(res.status).toBe(200);
    const [materials] = (res.json as J).packs;
    expect(materials).toMatchObject({ id: "materials", name: "Materials" });
    expect(materials.templates).toEqual([]);
    expect(materials.clients.map((c: J) => c.enabled)).toEqual([false, false]);
    expect(materials.screens.map((s: J) => s.title)).toEqual([
      "Price watch",
      "Catalog",
      // P-9
      "Purchase requests",
    ]);
  });

  it("validates an agent built from the pack's skills against the platform's registries", () => {
    const result = validateBundle(PURCHASING_TEST_BUNDLE, {
      skills: Object.fromEntries(H.platform.catalog.list().map((s) => [s.id, s])),
      tools: H.platform.tools.specs(),
      events: H.platform.events.byType(),
    });
    expect(result.errors).toEqual([]);
  });

  it("switches the pack on for a client and installs no agent", async () => {
    const res = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${H.A.tenantId}/packs/materials/enable`,
    );
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const body = res.json as J;
    expect(body.pack).toMatchObject({ id: "materials", enabled: true });
    expect(body.installed).toEqual([]);

    // Again, and for another client: switched on, still nothing installed.
    const again = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${H.A.tenantId}/packs/materials/enable`,
    );
    expect((again.json as J).installed).toEqual([]);
    const forB = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${H.B.tenantId}/packs/materials/enable`,
    );
    expect((forB.json as J).installed).toEqual([]);
    const packTemplates = await H.t.db
      .select()
      .from(agentVersion)
      .where(eq(agentVersion.authorType, "pack"));
    expect(packTemplates).toEqual([]);
    const list = await H.call(OPERATOR, "GET", `/api/ops/clients/${H.A.tenantId}/packs`);
    expect((list.json as J).packs[0]).toMatchObject({ enabled: true });
    // A client the operator doesn't serve, and an unknown pack.
    expect(
      (await H.call(OPERATOR, "POST", `/api/ops/clients/${H.C.tenantId}/packs/materials/enable`))
        .status,
    ).toBe(404);
    expect(
      (await H.call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/packs/nope/enable`)).status,
    ).toBe(404);
  });

  it("runs a client's purchasing agent on an invoice it uploaded: priced lines and a price_jump alert", async () => {
    // The operator builds the agent as a template (as the Agent lab saves it), publishes it and
    // forks it into client A, then publishes and switches on the client's copy.
    const tpl = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "purchasing",
      bundle: PURCHASING_TEST_BUNDLE,
    });
    expect(tpl.status, JSON.stringify(tpl.json)).toBe(200);
    const templateId = (tpl.json as J).agent.id as string;
    const tplPub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${templateId}/versions/${(tpl.json as J).version.id}/publish`,
    );
    expect(tplPub.status, JSON.stringify(tplPub.json)).toBe(200);
    const fork = await H.call(OPERATOR, "POST", `/api/ops/templates/${templateId}/fork`, {
      clientId: H.A.tenantId,
      serviceName: "Material cost monitoring",
    });
    expect(fork.status, JSON.stringify(fork.json)).toBe(200);
    const buyerId = (fork.json as J).agent.id as string;
    const versionId = (fork.json as J).version.id as string;
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${buyerId}/versions/${versionId}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, buyerId));

    // The client paid $62.50 a sheet for 3/4 Baltic birch at Northline in October.
    const history = await withTenant(H.db, H.A.tenantId, async (tx) => {
      const vendor = await findOrCreateVendor(tx, H.A.tenantId, "Northline Panel Supply");
      const parsed = parseLine(BB);
      const [item] = await tx
        .insert(catalogItem)
        .values({
          tenantId: H.A.tenantId,
          category: parsed.category,
          canonicalName: canonicalName(parsed.category, parsed.attributes, parsed.normalized),
          attributes: parsed.attributes,
          standardUom: parsed.standardUom,
          keySignature: keySignature(parsed.category, parsed.attributes),
        })
        .returning();
      await tx.insert(priceObservation).values({
        tenantId: H.A.tenantId,
        catalogItemId: item?.id as string,
        vendorId: vendor?.id as string,
        observedOn: "2026-10-01",
        unitPriceStd: "62.5000",
        qtyStd: "40",
        standardUom: "sheet",
      });
      return { itemId: item?.id as string };
    });

    // The client uploads the invoice (read in the background from the recorded fixture), then
    // the purchase behind it: transaction.created starts the agent's purchase intake.
    const pdf = await upload(admin("a"), [
      { name: "northline-20418.pdf", type: "application/pdf", bytes: invoicePdf() },
    ]);
    expect(pdf.status, JSON.stringify(pdf.json)).toBe(200);
    const documentId = pdf.json.results[0].document.id as string;
    const before = new Set(H.instances.started.keys());
    const csv = await upload(admin("a"), [
      {
        name: "purchases.csv",
        type: "text/csv",
        bytes: new TextEncoder().encode(
          "Date,Vendor,Amount\n10/28/2026,Northline Panel Supply,9742.35\n",
        ),
      },
    ]);
    expect(csv.json.results[0]).toMatchObject({ kind: "purchases", purchases: { created: 1 } });
    const started = [...H.instances.started.entries()].filter(
      ([id, p]) => !before.has(id) && (p as RunParams).agentId === buyerId,
    );
    expect(started).toHaveLength(1);
    const params = started[0]?.[1] as RunParams;
    expect(params.workflowSlug).toBe("purchase-intake");

    const result = await executeRun(
      {
        db: H.db,
        platform: H.platform,
        transport: H.extraction.transport as NonNullable<typeof H.extraction.transport>,
        instances: H.instances,
        documents: { content: new ContentStore(H.objects) },
      },
      params,
      cloudflareStepRunner(new FakeWorkflowStep()),
    );
    expect(result, JSON.stringify(result)).toEqual({ status: "succeeded" });

    const steps = await H.t.db.select().from(stepRun).where(eq(stepRun.runId, params.runId));
    const step = (id: string) => steps.find((s) => s.nodeId === id);
    expect(step("find")?.output).toMatchObject({ status: "found", documentIds: [documentId] });
    // Every line was settled by the rules (no model call): one matched, five new items.
    expect(step("match")?.output).toMatchObject({
      total: 6,
      matched: 1,
      newItems: 5,
      needsReview: 0,
    });
    expect(step("prices")?.summary).toBe("Recorded 6 prices from 6 lines");
    expect(step("check")?.summary).toMatch(/raised [1-9]\d* alerts?$/);

    const prices = await H.t.db
      .select()
      .from(priceObservation)
      .where(
        and(
          eq(priceObservation.tenantId, H.A.tenantId),
          eq(priceObservation.catalogItemId, history.itemId),
        ),
      );
    expect(prices.map((p) => [p.observedOn, p.unitPriceStd]).sort()).toEqual([
      ["2026-10-01", "62.5000"],
      ["2026-10-28", "68.5000"],
    ]);
    const recorded = prices.find((p) => p.observedOn === "2026-10-28");
    expect(recorded?.agentVersionId).toBe(params.agentVersionId);

    const [jump] = await H.t.db
      .select()
      .from(alert)
      .where(and(eq(alert.tenantId, H.A.tenantId), eq(alert.kind, "price_jump")));
    expect(jump).toMatchObject({
      status: "open",
      subjectId: history.itemId,
      agentVersionId: params.agentVersionId,
      raisedByRunId: params.runId,
    });
    expect(jump?.evidence).toContain(recorded?.id);
    // $6 a sheet more × (40 + 40) sheets in the last 90 days.
    expect(jump?.dollarImpact).toBe("480.0000");
  });

  it("shows the client its Price watch with the alert and the invoice behind it, and as CSV", async () => {
    const res = await H.call(admin("a"), "GET", "/api/reports/materials/prices");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const report = (res.json as J).report;
    expect(forbiddenKeys(res.json)).toEqual([]);
    const bb = report.rows.find(
      (r: J) =>
        r.item.startsWith("Baltic birch plywood 3/4in") && r.vendor === "Northline Panel Supply",
    );
    expect(bb).toMatchObject({ lastPrice: "68.5000", previousPrice: "62.5000", changePct: "9.6" });
    expect(bb.series).toHaveLength(2);
    const jump = report.alerts.find((a: J) => a.kind === "price_jump");
    expect(jump.title).toMatch(/up 9\.6% at Northline Panel Supply/);
    expect(jump.documents).toEqual([
      { id: expect.any(String), label: "Northline Panel Supply invoice 20418" },
    ]);
    // The client user sees it too.
    expect((await H.call(user("a"), "GET", "/api/reports/materials/prices")).status).toBe(200);

    const csv = await H.app.request(
      "/api/reports/materials/prices/csv",
      { headers: { [DEV_USER_HEADER]: admin("a") } },
      H.env,
    );
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(csv.headers.get("content-disposition")).toMatch(
      /^attachment; filename="materials-prices-/,
    );
    const text = await csv.text();
    expect(text.split("\r\n")[0]).toMatch(/^Item,Category,Unit,Vendor,Last price/);
    expect(text).toContain("Northline Panel Supply,68.5000");

    const catalog = await H.call(admin("a"), "GET", "/api/reports/materials/catalog");
    expect((catalog.json as J).report.items.length).toBeGreaterThanOrEqual(1);
    const packs = await H.call(user("a"), "GET", "/api/packs");
    expect((packs.json as J).packs.map((p: J) => p.id)).toEqual(["materials"]);
    expect((await H.call(admin("a"), "GET", "/api/reports/materials/nope")).status).toBe(404);
  });

  it("shows the back office the same views for the client, and another client nothing", async () => {
    const ops = await H.call(
      OPERATOR,
      "GET",
      `/api/ops/clients/${H.A.tenantId}/reports/materials/prices`,
    );
    expect(ops.status).toBe(200);
    expect((ops.json as J).report.alerts.some((a: J) => a.kind === "price_jump")).toBe(true);
    const opsCsv = await H.app.request(
      `/api/ops/clients/${H.A.tenantId}/reports/materials/catalog/csv`,
      { headers: { [DEV_USER_HEADER]: OPERATOR } },
      H.env,
    );
    expect(opsCsv.status).toBe(200);

    const b = await H.call(admin("b"), "GET", "/api/reports/materials/prices");
    expect((b.json as J).report.rows).toEqual([]);
    expect((b.json as J).report.alerts).toEqual([]);
    // Client C hasn't the pack: no report.
    expect((await H.call(admin("c"), "GET", "/api/reports/materials/prices")).status).toBe(404);
    expect(
      (await H.call(OPERATOR, "GET", `/api/ops/clients/${H.C.tenantId}/reports/materials/prices`))
        .status,
    ).toBe(404);
  });

  it("lets the assignee decide a match review line by line, teaching the catalog", async () => {
    const lines = await H.t.db.select().from(docLine).where(eq(docLine.tenantId, H.A.tenantId));
    const line = lines.find((l) => l.rawDescription.startsWith("Hardboard")) ?? lines[0];
    const [item] = await H.t.db
      .insert(inboxItem)
      .values({
        tenantId: H.A.tenantId,
        kind: "request",
        title: "Which catalog items are these invoice lines?",
        assigneeRole: "client_admin",
        payload: { review: "materials.match", docLineIds: [line?.id] },
      })
      .returning();
    const path = `/api/inbox/${item?.id}/pack-review`;
    const view = await H.call(admin("a"), "GET", path);
    expect(view.status, JSON.stringify(view.json)).toBe(200);
    expect(view.json).toMatchObject({ review: "materials.match", status: "open", canDecide: true });
    expect((view.json as J).data.lines[0].docLineId).toBe(line?.id);
    expect(forbiddenKeys(view.json)).toEqual([]);

    // A client user can't see the admin's item; another client can't either.
    expect(
      (await H.call(user("a"), "POST", path, { docLineId: line?.id, action: "new_item" })).status,
    ).toBe(404);
    expect((await H.call(admin("b"), "GET", path)).status).toBe(404);
    // A line that isn't in the review.
    const other = lines.find((l) => l.id !== line?.id);
    expect(
      (await H.call(admin("a"), "POST", path, { docLineId: other?.id, action: "new_item" })).status,
    ).toBe(422);

    const decided = await H.call(admin("a"), "POST", path, {
      docLineId: line?.id,
      action: "match",
      catalogItemId: (
        await H.t.db.select().from(catalogItem).where(eq(catalogItem.tenantId, H.A.tenantId))
      )[0]?.id,
    });
    expect(decided.status, JSON.stringify(decided.json)).toBe(200);
    expect((decided.json as J).data.lines[0]).toMatchObject({
      decision: "matched",
      method: "human",
    });
    const human = await H.t.db
      .select()
      .from(itemMatch)
      .where(and(eq(itemMatch.docLineId, line?.id as string), eq(itemMatch.method, "human")));
    expect(human).toHaveLength(1);
    // Skip records nothing.
    const skip = await H.call(admin("a"), "POST", path, { docLineId: line?.id, action: "skip" });
    expect(skip.status).toBe(200);
    // The back office reads it too, but the item is the client admin's to decide.
    const ops = await H.call(OPERATOR, "GET", `/api/ops/inbox/${item?.id}/pack-review`);
    expect(ops.json).toMatchObject({ canDecide: false });
    expect(
      (
        await H.call(OPERATOR, "POST", `/api/ops/inbox/${item?.id}/pack-review`, {
          docLineId: line?.id,
          action: "new_item",
        })
      ).status,
    ).toBe(403);
  });

  it("merges two catalog items from the back office, never across categories", async () => {
    const insert = async (description: string) => {
      const parsed = parseLine(description);
      const [row] = await H.t.db
        .insert(catalogItem)
        .values({
          tenantId: H.A.tenantId,
          category: parsed.category,
          canonicalName: `${canonicalName(parsed.category, parsed.attributes, parsed.normalized)} (dup)`,
          attributes: parsed.attributes,
          standardUom: parsed.standardUom,
        })
        .returning();
      return row?.id as string;
    };
    const items = await H.t.db
      .select()
      .from(catalogItem)
      .where(and(eq(catalogItem.tenantId, H.A.tenantId), isNull(catalogItem.mergedIntoId)));
    const bb = items.find((i) => i.canonicalName.startsWith("Baltic birch plywood 3/4in"));
    const dup = await insert("BALTIC BIRCH PLYWOOD 3/4 BB/BB");
    const path = `/api/ops/clients/${H.A.tenantId}/packs/materials/actions/merge-items`;
    const res = await H.call(OPERATOR, "POST", path, { fromId: dup, intoId: bb?.id });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect((res.json as J).result).toMatchObject({ intoId: bb?.id, merged: [dup] });
    const [merged] = await H.t.db.select().from(catalogItem).where(eq(catalogItem.id, dup));
    expect(merged?.mergedIntoId).toBe(bb?.id);

    const oak = await insert("4/4 RED OAK FAS");
    const refused = await H.call(OPERATOR, "POST", path, { fromId: oak, intoId: bb?.id });
    expect(refused.status).toBe(422);
    expect((await H.call(OPERATOR, "POST", path, { fromId: "nope" })).status).toBe(400);
    expect(
      (
        await H.call(
          OPERATOR,
          "POST",
          `/api/ops/clients/${H.A.tenantId}/packs/materials/actions/delete-everything`,
          {},
        )
      ).status,
    ).toBe(404);
  });

  it("keeps the pack off for clients the operator never switched it on for", async () => {
    const rows = await H.t.db
      .select()
      .from(tenantPack)
      .where(eq(tenantPack.tenantId, H.C.tenantId));
    expect(rows).toEqual([]);
  });
});
