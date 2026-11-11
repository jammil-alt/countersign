// R8: the Library's banks through the API (docs/plan.md §1.86; ARCHITECTURE §10.14 "The Library
// and the client's settings"). Only operators reach them (invariant 11); a template's workflows
// read as v4 processes while the stored v3 version is left as it was (invariant 3); tools carry
// their side effect, record type and undo; condition sets are derived from the processes, grouped
// where the same rules are used twice, and a client's own automation shows only to its operator.

import { TESTKIT_QUERY_TOOL, TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import { AgentBundle, type AgentBundleInput } from "@countersign/core";
import { agentVersion } from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  OPERATOR,
  OTHER_OPERATOR,
  testBundle,
} from "./api.test-helper";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const h = await createApiHarness();
afterAll(() => h?.close());

const BIG = { match: "all", rules: [{ field: "{{trigger.amount}}", op: ">", value: 5000 }] };

/** The test bundle with a fork on the amount, and the same rule on a person step's path. */
function libraryBundle(): AgentBundle {
  const base = testBundle("Bill keeper");
  const input = JSON.parse(JSON.stringify(base)) as AgentBundleInput;
  const w = input.workflows[0];
  if (!w) throw new Error("no workflow");
  w.workflow.steps.push({
    id: "size",
    name: "How big",
    kind: "fork",
    paths: [
      {
        id: "big",
        name: "Big bills",
        when: BIG as never,
        steps: [
          {
            id: "tell",
            name: "Tell the lead",
            kind: "notify",
            channel: "thread",
            message: "A big one",
          },
        ],
      },
      {
        id: "huge",
        name: "Huge bills",
        when: {
          match: "all",
          rules: [{ field: "{{trigger.amount}}", op: ">", value: 50000 }],
        },
        steps: [],
      },
    ],
    otherwise: { id: "small", steps: [] },
  } as never);
  return AgentBundle.parse(input);
}

describe.skipIf(!h)("the Library", () => {
  const H = h as ApiHarness;
  let templateId = "";
  let v1 = "";

  beforeAll(async () => {
    const created = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "bill-keeper",
      bundle: libraryBundle(),
      releaseNote: "First",
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    templateId = j(created.json).agent.id;
    v1 = j(created.json).version.id;
    const published = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${templateId}/versions/${v1}/publish`,
    );
    expect(published.status, JSON.stringify(published.json)).toBe(200);
    for (const clientId of [H.A.tenantId, H.B.tenantId]) {
      const forked = await H.call(OPERATOR, "POST", `/api/ops/templates/${templateId}/fork`, {
        clientId,
      });
      expect(forked.status, JSON.stringify(forked.json)).toBe(200);
    }
    // Client A's own automation, with the big-bill rule on a fork of its own.
    const auto = await H.call(OPERATOR, "POST", "/api/ops/automations", {
      clientId: H.A.tenantId,
      definition: {
        schemaVersion: 1,
        slug: "a-big-check",
        name: "A's big check",
        input: { type: "object", properties: { amount: { type: "number" } } },
        steps: [
          {
            id: "check",
            name: "Check the size",
            kind: "fork",
            paths: [
              {
                id: "over",
                name: "Over the line",
                when: {
                  match: "all",
                  rules: [{ field: "{{trigger.amount}}", op: ">", value: 5000 }],
                },
                steps: [],
              },
            ],
            otherwise: { id: "under", steps: [] },
          },
        ],
        output: {},
      },
    });
    expect(auto.status, JSON.stringify(auto.json)).toBe(200);
  });

  it("is the operator's only", async () => {
    for (const path of [
      "/api/ops/library",
      "/api/ops/library/processes",
      "/api/ops/library/tools",
      "/api/ops/library/record-types",
      "/api/ops/library/conditions",
    ]) {
      expect((await H.call(admin("a"), "GET", path)).status, path).toBe(403);
      expect((await H.call(null, "GET", path)).status, path).toBe(401);
    }
  });

  it("lists templates with their versions, each workflow read as a v4 process", async () => {
    const before = await H.t.db.select().from(agentVersion).where(eq(agentVersion.id, v1));
    const res = await H.call(OPERATOR, "GET", "/api/ops/library/processes");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const p = j(res.json).processes.find((x: { slug: string }) => x.slug === "bill-keeper");
    expect(p).toMatchObject({
      id: templateId,
      name: "Bill keeper",
      description: "keep records right",
      liveVersion: 1,
      latestVersion: 1,
      shownVersion: 1,
      usedBy: 2,
      versions: [{ id: v1, version: 1, status: "live", schemaVersion: 3 }],
    });
    const [w] = p.workflows;
    expect(w).toMatchObject({
      slug: "fix-record",
      schemaVersion: 3,
      triggers: [{ id: "trg-manual", kind: "manual", event: null }],
      // update, confirm, internal, size, and the notify inside the big path.
      steps: 5,
      kinds: { write: 1, person: 1, notify: 2, if: 1 },
      checks: { confer: 0, approval: 1, notify: 0 },
    });
    // Reading never rewrites the stored version (invariant 3).
    const after = await H.t.db.select().from(agentVersion).where(eq(agentVersion.id, v1));
    expect(after).toEqual(before);
  });

  it("lists tools with side effect, record type and undo, and the skills that only wrap them", async () => {
    const res = await H.call(OPERATOR, "GET", "/api/ops/library/tools");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const tools = j(res.json).tools as { id: string }[];
    expect(tools.find((t) => t.id === TESTKIT_UPDATE_TOOL)).toMatchObject({
      source: "testkit",
      connector: "testkit",
      sideEffect: "external",
      verb: "update",
      entities: ["record"],
      undo: { kind: "restore" },
      undoDeclared: true,
      alwaysSigned: false,
    });
    expect(tools.find((t) => t.id === TESTKIT_QUERY_TOOL)).toMatchObject({
      sideEffect: "none",
      verb: "read",
      undo: null,
      // Every connector read is a generated tool-mode skill: retiring.
      wrappedBy: [TESTKIT_QUERY_TOOL],
    });
  });

  it("lists record types from connectors' entities with their tools, and ours", async () => {
    const res = await H.call(OPERATOR, "GET", "/api/ops/library/record-types");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const types = j(res.json).recordTypes as { id: string }[];
    expect(types.find((t) => t.id === "testkit.record")).toMatchObject({
      connector: "testkit",
      entity: "record",
      label: "Records",
      verbs: ["read", "update"],
    });
    const testkit = types.find((t) => t.id === "testkit.record") as unknown as {
      tools: { id: string }[];
    };
    expect(testkit.tools.map((t) => t.id)).toContain(TESTKIT_UPDATE_TOOL);
    expect(types.find((t) => t.id === "document")).toMatchObject({
      connector: null,
      sourceName: "Platform",
    });
  });

  it("derives condition sets from the processes, grouped by the same rules", async () => {
    const res = await H.call(OPERATOR, "GET", "/api/ops/library/conditions");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const body = j(res.json);
    expect(body.source).toBe("derived");
    const big = body.sets.find((s: { name: string }) => s.name === "Big bills");
    expect(big.when).toEqual(BIG);
    expect(big.key).toMatch(/^[0-9a-f]{16}$/);
    expect(
      big.uses.map((u: { processKind: string; place: string; stepId: string }) => [
        u.processKind,
        u.place,
        u.stepId,
      ]),
    ).toEqual([
      ["template", "if_path", "size"],
      ["automation", "if_path", "check"],
    ]);
    expect(body.sets.find((s: { name: string }) => s.name === "Huge bills").uses).toHaveLength(1);

    // Client A's automation is A's: an operator who serves only client C doesn't see it.
    const other = await H.call(OTHER_OPERATOR, "GET", "/api/ops/library/conditions");
    expect(other.status).toBe(200);
    const theirs = j(other.json).sets.find((s: { name: string }) => s.name === "Big bills");
    expect(theirs.uses.map((u: { processKind: string }) => u.processKind)).toEqual(["template"]);
  });

  // Skill model (2026-11-10): a skill that only wraps a tool leaves the list (a process uses the
  // tool directly); every skill says its kind, label, parameters and recommended model.
  it("gives the skills list each skill's method, kind, reads, browsing and parameters, wrappers left out", async () => {
    const res = await H.call(OPERATOR, "GET", "/api/ops/skills");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const skills = j(res.json).skills as {
      ref: string;
      retired: boolean;
      wraps: string | null;
      method: string;
      kind: string;
      kindLabel: string;
      parameters: unknown[];
      recommendedModel: unknown;
      modelTools: string[];
    }[];
    expect(skills.find((s) => s.ref === TESTKIT_QUERY_TOOL)).toBeUndefined();
    expect(skills.length).toBeGreaterThan(0);
    for (const s of skills) {
      expect(s.retired, s.ref).toBe(false);
      expect(s.wraps).toBeNull();
      expect(["rules", "ai", "rules_then_ai"]).toContain(s.method);
      expect({ kind: s.kind, label: s.kindLabel }).toEqual(
        s.kind === "ai"
          ? { kind: "ai", label: "AI" }
          : { kind: "deterministic", label: "Deterministic" },
      );
      expect(Array.isArray(s.parameters)).toBe(true);
      // A code skill is AI only because a tool it calls calls a model.
      if (s.method === "rules") expect(s.kind === "ai").toBe(s.modelTools.length > 0);
    }
    const task = skills.find((s) => s.recommendedModel !== null);
    expect(task?.kind).toBe("ai");
  });

  it("counts every bank", async () => {
    const res = await H.call(OPERATOR, "GET", "/api/ops/library");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const banks = Object.fromEntries(
      j(res.json).banks.map((b: { bank: string; count: number; retired: number }) => [b.bank, b]),
    );
    expect(Object.keys(banks)).toEqual([
      "processes",
      "skills",
      "tools",
      "connectors",
      "triggers",
      "record_types",
      "conditions",
    ]);
    // One template and A's automation.
    expect(banks.processes.count).toBe(2);
    expect(banks.skills.retired).toBeGreaterThan(0);
    expect(banks.tools.count).toBe(H.platform.tools.list().length);
    expect(banks.connectors.count).toBe(H.platform.connectors.list().length);
    expect(banks.conditions.count).toBe(2);
    // The other operator serves neither A nor its automation.
    const other = await H.call(OTHER_OPERATOR, "GET", "/api/ops/library");
    const theirs = j(other.json).banks.find((b: { bank: string }) => b.bank === "processes");
    expect(theirs.count).toBe(1);
  });
});
