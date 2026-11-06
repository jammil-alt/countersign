import { describe, expect, it } from "vitest";
import { checkRouteContract, forbiddenPortalFields } from "../api/contract";
import { clientViewRoutes, ServiceView } from "../api/client-view";
import { mergeBundles } from "../bundle/merge";
import { bundleHash } from "../canonical";
import { AgentBundle as AgentBundleSchema, type AgentBundleInput } from "../schemas/agent";
import { bundle, bundleInput, ctx, edit } from "../testing/fixtures";
import { validateBundle } from "../workflow/validate";
import { formatKpi } from "./format";
import { kpiBounds } from "./period";
import { ClientView, kpiPathProblem, ratioDepth } from "./schema";

const plain = { kind: "sum", step: "s1", path: "match.matched" } as const;

function withView(view: unknown): AgentBundleInput {
  return edit(bundleInput(), (b) => {
    (b.definition as Record<string, unknown>).clientView = view;
  });
}

const codes = (input: unknown, packs?: string[]) =>
  validateBundle(input, { ...ctx, ...(packs ? { packs } : {}) }).errors.map((e) => e.code);

const view = {
  kpis: [
    {
      id: "auto",
      label: { en: "Items matched on their own", es: "Artículos emparejados solos" },
      period: "30d",
      format: "percent",
      measure: {
        kind: "ratio",
        numerator: plain,
        denominator: { kind: "sum", step: "s6", path: "match.total" },
      },
    },
    {
      id: "caught",
      label: "Overcharges caught",
      period: "month",
      format: "money",
      measure: { kind: "sum", step: "s3", path: "overcharge", money: true },
    },
    { id: "runs", label: "Invoices read", period: "week", format: "count", measure: { kind: "runs", workflow: "intake" } },
  ],
  panels: [
    { id: "main", kind: "kpis", kpis: ["auto", "caught", "runs"] },
    { id: "prices", kind: "pack_report", pack: "materials", report: "prices" },
  ],
};

describe("clientView in the bundle", () => {
  it("is optional with no default: a bundle without it hashes as before", async () => {
    const before = bundle();
    expect("clientView" in before.definition).toBe(false);
    const parsed = AgentBundleSchema.parse(JSON.parse(JSON.stringify(before)));
    expect("clientView" in parsed.definition).toBe(false);
    expect(await bundleHash(parsed)).toBe(await bundleHash(before));
  });

  it("accepts a view whose KPIs name steps and workflows of the bundle", () => {
    expect(codes(withView(view))).toEqual([]);
    expect(codes(withView(view), ["materials"])).toEqual([]);
  });

  it("refuses duplicate ids, unknown steps and workflows, deep ratios and unknown KPIs", () => {
    const bad = edit(view, (v) => {
      v.kpis.push({ ...JSON.parse(JSON.stringify(v.kpis[2])), id: "runs" });
      (v.kpis[1] as { measure: { step: string } }).measure.step = "nope";
      (v.kpis[2] as { measure: { workflow: string } }).measure.workflow = "other";
      v.kpis.push({
        id: "deep",
        label: "Deep",
        period: "7d",
        format: "percent",
        measure: {
          kind: "ratio",
          numerator: { kind: "ratio", numerator: { kind: "ratio", numerator: plain, denominator: plain }, denominator: plain },
          denominator: plain,
        },
      } as never);
      v.panels[0]?.kpis?.push("missing");
    });
    expect(codes(withView(bad)).sort()).toEqual(
      [
        "duplicate_kpi",
        "kpi_ratio_depth",
        "kpi_unknown",
        "kpi_unknown_step",
        "kpi_unknown_workflow",
      ].sort(),
    );
  });

  it("refuses a pack panel for a pack that isn't installed (when the packs are known)", () => {
    expect(codes(withView(view), [])).toEqual(["kpi_pack_missing"]);
  });

  it("allows paths of dotted identifiers only", () => {
    expect(kpiPathProblem("match.matched")).toBeNull();
    expect(kpiPathProblem("a_1.b")).toBeNull();
    for (const p of ["", "a..b", "a.0", "a[0]", "a.*", "1a", "a.__proto__", "constructor", "x.prototype.y"]) {
      expect(kpiPathProblem(p), p).not.toBeNull();
    }
    expect(kpiPathProblem("a".repeat(201))).not.toBeNull();
    const parsed = ClientView.safeParse(
      edit(view, (v) => {
        (v.kpis[1] as { measure: { path: string } }).measure.path = "a.__proto__";
      }),
    );
    expect(parsed.success).toBe(false);
  });

  it("measures ratio depth", () => {
    expect(ratioDepth(plain)).toBe(0);
    expect(ratioDepth({ kind: "ratio", numerator: plain, denominator: plain })).toBe(1);
  });

  it("merges its lists as whole values: both sides changing them conflicts", () => {
    const base = AgentBundleSchema.parse(withView(view));
    const ours = edit(base, (b) => {
      b.definition.clientView?.kpis.pop();
    });
    const theirs = edit(base, (b) => {
      if (b.definition.clientView?.kpis[0]) b.definition.clientView.kpis[0].period = "7d";
    });
    expect(mergeBundles(base, ours, theirs).conflicts.length).toBeGreaterThan(0);
    const onlyOurs = mergeBundles(base, ours, base);
    expect(onlyOurs.clean).toBe(true);
    expect(onlyOurs.bundle.definition.clientView?.kpis.length).toBe(2);
  });
});

describe("the client view's routes", () => {
  it("keep definitions and cost out of the portal's answers", () => {
    expect(checkRouteContract(clientViewRoutes)).toEqual([]);
    expect(forbiddenPortalFields(ServiceView)).toEqual([]);
  });
});

describe("KPI periods and formats", () => {
  const now = new Date("2026-11-06T15:30:00Z"); // a Friday

  it("starts each period at local midnight", () => {
    const ny = "America/New_York";
    expect(kpiBounds("7d", now, ny).from.toISOString()).toBe("2026-10-31T04:00:00.000Z");
    expect(kpiBounds("30d", now, "UTC").from.toISOString()).toBe("2026-10-08T00:00:00.000Z");
    expect(kpiBounds("week", now, "UTC").from.toISOString()).toBe("2026-11-02T00:00:00.000Z");
    expect(kpiBounds("month", now, ny).from.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(kpiBounds("month", now, ny).to).toBe(now);
  });

  it("formats exact decimals in the reader's language", () => {
    expect(formatKpi("1204", "count", "en")).toBe("1,204");
    expect(formatKpi("12345678901234.1250", "money", "en")).toBe("$12,345,678,901,234.13");
    expect(formatKpi("3120.5", "money", "de", "EUR")).toMatch(/^3\.120,50\s€$/);
    expect(formatKpi("0.875", "percent", "en")).toBe("87.5%");
    expect(formatKpi(null, "percent", "en")).toBeNull();
  });
});
