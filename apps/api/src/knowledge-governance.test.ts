// B6 (docs/builder-plan.md §8): the client's charter and tagged policies through the knowledge
// routes, over a throwaway database. We draft the charter from onboarding's facts (the client's
// own, never ours) with a FakeModel; it is saved not confirmed; the client admin confirms it in the
// portal, and only then is it what agents read. Tags and tiers go in and come back; the portal's
// answers carry nothing of an agent.

import { CHARTER_DRAFT_TOOL, FORBIDDEN_PORTAL_FIELD } from "@countersign/core";
import { clientFact, clientFile } from "@countersign/db";
import { clientGovernance } from "@countersign/documents";
import { FakeModel } from "@countersign/llm";
import { afterAll, describe, expect, it } from "vitest";
import { admin, createApiHarness, OPERATOR, user } from "./api.test-helper";

const model = new FakeModel([
  (request) => {
    // The facts reach the model as data, and only the client's own.
    const text = JSON.stringify(request.messages);
    expect(text).toContain("Family lumber yard in Austin");
    expect(text).not.toContain("Owner is hard to reach");
    return {
      toolUse: {
        name: CHARTER_DRAFT_TOOL,
        input: {
          whoWeAre: "We are a family lumber yard in Austin.",
          howWeSpeak: "Warm, plain and direct.",
          whatMatters: ["Accurate invoices", "Quick replies to builders"],
          whatWeNeverDo: ["We never pressure a customer."],
        },
      },
    };
  },
]);

const h = await createApiHarness({ llm: model });
afterAll(() => h?.close());

type Json = Record<string, unknown>;
type Entry = Json & {
  id: string;
  version: number;
  tier: string | null;
  tags: string[];
  confirmed: { by: string | null; at: string } | null;
  inUseVersion?: number | null;
  body: string;
};

function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysOf(v, out);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysOf(v, out);
    }
  }
  return out;
}

describe.skipIf(!h)("governance through the knowledge routes", () => {
  const H = h as NonNullable<typeof h>;
  const call = H.call.bind(H);
  const A = () => H.A.tenantId;
  let charter: Entry;

  it("refuses to draft a charter with nothing from onboarding", async () => {
    const res = await call(OPERATOR, "POST", `/api/ops/clients/${A()}/knowledge/charter/draft`, {});
    expect(res.status).toBe(409);
    expect((res.json as { error: Json }).error.code).toBe("no_facts");
    expect(model.requests).toHaveLength(0);
  });

  it("drafts the charter from the client's own facts, saved not confirmed", async () => {
    const [file] = await H.t.db
      .insert(clientFile)
      .values({ name: "Client A", clientId: A(), status: "client" })
      .returning();
    if (!file) throw new Error("no file");
    await H.t.db.insert(clientFact).values([
      {
        fileId: file.id,
        section: "business",
        text: "Family lumber yard in Austin",
        sourceKind: "call",
        audience: "theirs",
        actor: "operator",
      },
      {
        fileId: file.id,
        section: "notes",
        text: "Owner is hard to reach",
        sourceKind: "note",
        audience: "ours",
        actor: "operator",
      },
    ]);
    const res = await call(OPERATOR, "POST", `/api/ops/clients/${A()}/knowledge/charter/draft`, {});
    expect(res.status).toBe(200);
    const out = res.json as { entry: Entry; from: Json };
    charter = out.entry;
    expect(out.from).toEqual({ facts: 1, about: 0 });
    expect(charter).toMatchObject({
      kind: "policy",
      tier: "charter",
      title: "Our charter",
      confirmed: null,
      inUseVersion: null,
      version: 1,
    });
    expect(charter.body).toContain("We are a family lumber yard in Austin.");
    expect(charter.body).toContain("What we never do\n- We never pressure a customer.");
    expect(model.requests).toHaveLength(1);
    // Not confirmed: agents read no charter yet.
    const g = await H.t.db.transaction((tx) => clientGovernance(tx as never, A()));
    expect(g.charter).toBeNull();
  });

  it("refuses a second charter", async () => {
    const res = await call(OPERATOR, "POST", `/api/ops/clients/${A()}/knowledge/entries`, {
      kind: "policy",
      tier: "charter",
      title: "Another",
      body: "Text",
    });
    expect(res.status).toBe(409);
    expect((res.json as { error: Json }).error.code).toBe("charter_exists");
  });

  it("the client admin sees it in the portal and confirms it; agents then read it", async () => {
    const list = await call(admin("a"), "GET", "/api/knowledge");
    expect(list.status).toBe(200);
    const entries = (list.json as { entries: Entry[] }).entries;
    expect(entries.find((e) => e.id === charter.id)).toMatchObject({ tier: "charter" });
    // Nothing of an agent: no bundle, instructions, prompt or cost in any field.
    for (const k of keysOf(list.json)) expect(FORBIDDEN_PORTAL_FIELD.test(k)).toBe(false);

    const stale = await call(admin("a"), "POST", `/api/knowledge/entries/${charter.id}/confirm`, {
      baseVersion: 7,
    });
    expect(stale.status).toBe(409);
    expect((stale.json as { error: Json }).error.code).toBe("stale");

    const ok = await call(admin("a"), "POST", `/api/knowledge/entries/${charter.id}/confirm`, {
      baseVersion: 1,
    });
    expect(ok.status).toBe(200);
    charter = (ok.json as { entry: Entry }).entry;
    expect(charter).toMatchObject({ version: 2, inUseVersion: 2 });
    expect(charter.confirmed).toMatchObject({ by: "Client A admin" });

    // Confirming again saves nothing.
    const again = await call(admin("a"), "POST", `/api/knowledge/entries/${charter.id}/confirm`, {
      baseVersion: 2,
    });
    expect((again.json as { entry: Entry }).entry.version).toBe(2);

    const g = await H.t.db.transaction((tx) => clientGovernance(tx as never, A()));
    expect(g.charter).toMatchObject({ entryId: charter.id, version: 2 });
  });

  it("our edit waits for the client admin: agents keep the confirmed version", async () => {
    const edited = await call(
      OPERATOR,
      "PUT",
      `/api/ops/clients/${A()}/knowledge/entries/${charter.id}`,
      { title: "Our charter", body: `${charter.body}\n\nNEW LINE`, baseVersion: 2 },
    );
    expect(edited.status).toBe(200);
    const e = (edited.json as { entry: Entry }).entry;
    expect(e).toMatchObject({ version: 3, confirmed: null, inUseVersion: 2, tier: "charter" });
    const g = await H.t.db.transaction((tx) => clientGovernance(tx as never, A()));
    expect(g.charter?.version).toBe(2);
    expect(g.charter?.body).not.toContain("NEW LINE");

    // The client admin's own edit confirms it.
    const own = await call(admin("a"), "PUT", `/api/knowledge/entries/${charter.id}`, {
      title: "Our charter",
      body: `${charter.body}\n\nTHEIR LINE`,
      baseVersion: 3,
    });
    expect(own.status).toBe(200);
    expect((own.json as { entry: Entry }).entry).toMatchObject({ version: 4, inUseVersion: 4 });
    const after = await H.t.db.transaction((tx) => clientGovernance(tx as never, A()));
    expect(after.charter?.body).toContain("THEIR LINE");
  });

  it("policies take tags in and give them back; agents read tagged ones", async () => {
    const created = await call(admin("a"), "POST", "/api/knowledge/entries", {
      kind: "policy",
      tier: "policy",
      tags: ["purchasing", "money", "money"],
      title: "Returns",
      body: "Returns over $500 need the yard manager.",
    });
    expect(created.status).toBe(200);
    const p = (created.json as { entry: Entry }).entry;
    expect(p).toMatchObject({ tier: "policy", tags: ["money", "purchasing"] });
    expect(p.confirmed).not.toBeNull();

    const bad = await call(admin("a"), "POST", "/api/knowledge/entries", {
      kind: "faq",
      tags: ["money"],
      title: "Q",
      body: "A",
    });
    expect(bad.status).toBe(400);
    const unknown = await call(admin("a"), "POST", "/api/knowledge/entries", {
      kind: "policy",
      tags: ["whatever"],
      title: "Q",
      body: "A",
    });
    expect(unknown.status).toBe(400);

    // An edit that leaves tags out keeps them; one that names them replaces them.
    const kept = await call(OPERATOR, "PUT", `/api/ops/clients/${A()}/knowledge/entries/${p.id}`, {
      title: "Returns",
      body: "Returns over $400 need the yard manager.",
      baseVersion: 1,
    });
    expect((kept.json as { entry: Entry }).entry.tags).toEqual(["money", "purchasing"]);
    const retagged = await call(
      OPERATOR,
      "PUT",
      `/api/ops/clients/${A()}/knowledge/entries/${p.id}`,
      {
        title: "Returns",
        body: "Returns over $400 need the yard manager.",
        baseVersion: 2,
        tags: ["purchasing"],
      },
    );
    expect((retagged.json as { entry: Entry }).entry.tags).toEqual(["purchasing"]);

    const versions = await call(
      OPERATOR,
      "GET",
      `/api/ops/clients/${A()}/knowledge/entries/${p.id}/versions`,
    );
    const vs = (versions.json as { versions: Entry[] }).versions;
    expect(vs.map((v) => v.tags)).toEqual([
      ["money", "purchasing"],
      ["money", "purchasing"],
      ["purchasing"],
    ]);
    // Ours are not confirmed; the client admin's first version was.
    expect(vs.map((v) => v.confirmed !== null)).toEqual([true, false, false]);

    const g = await H.t.db.transaction((tx) => clientGovernance(tx as never, A()));
    expect(g.policies.map((x) => [x.entryId, x.tags])).toEqual([[p.id, ["purchasing"]]]);
  });

  it("only the client admin confirms, and only their own client's entries", async () => {
    const asUser = await call(user("a"), "POST", `/api/knowledge/entries/${charter.id}/confirm`, {
      baseVersion: 4,
    });
    expect(asUser.status).toBe(403);
    const other = await call(admin("b"), "POST", `/api/knowledge/entries/${charter.id}/confirm`, {
      baseVersion: 4,
    });
    expect(other.status).toBe(404);
  });
});
