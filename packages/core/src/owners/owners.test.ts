// v0.17 (ARCHITECTURE §10.15, docs/plan.md §1.96): areas, names, the owner's settings and which
// ones a run uses, the signature, and `remember` on a decision.

import { describe, expect, it } from "vitest";
import { LOCALES } from "../i18n/locale";
import { OWNER_WORDS, ownerSignature } from "../i18n/owners";
import { OversightDecision, oversightFinishSchema } from "../oversight/decision";
import { AgentBundle } from "../schemas/agent";
import { processArea } from "./areas";
import {
  defaultOwnerDefinition,
  OwnerDefinition,
  type PinnedAreaOwner,
  runOwnerOf,
} from "./definition";
import { nextOwnerName, OWNER_NAME_POOL, ownerNameProblem } from "./names";

const v3 = (oversight?: unknown) =>
  AgentBundle.parse({
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name: "Bill clerk", role: "Enters bills", mission: "Bills in" },
      kind: "functional",
      model: { id: "claude-haiku-5-5", maxTokens: 2048 },
      instructions: "Enter bills.",
      skills: [],
      permissions: { mode: "suggest_only" },
      ...(oversight ? { oversight } : {}),
    },
    workflows: [],
  });

const pia = (definition: unknown): PinnedAreaOwner => ({
  ownerId: "o1",
  versionId: "v1",
  name: "Pia",
  area: "purchasing",
  definition: OwnerDefinition.parse(definition),
});

describe("areas", () => {
  it("takes the operator's area first, then the template's, then its one area pack", () => {
    expect(processArea({ set: "sales", declared: "purchasing" })).toBe("sales");
    expect(processArea({ set: null, declared: "receivables" })).toBe("receivables");
    expect(processArea({ requiresPacks: ["materials"] })).toBe("purchasing");
    expect(processArea({ requiresPacks: ["materials", "bookkeeping"] })).toBe("general");
    expect(processArea({ set: "astrology" })).toBe("general");
    expect(processArea({})).toBe("general");
  });
});

describe("names", () => {
  it("has 40 names of 3 or 4 letters, none starting with S, none twice", () => {
    expect(OWNER_NAME_POOL).toHaveLength(40);
    expect(new Set(OWNER_NAME_POOL).size).toBe(40);
    for (const n of OWNER_NAME_POOL) {
      expect(n.length === 3 || n.length === 4, n).toBe(true);
      expect(n[0], n).not.toBe("S");
    }
  });

  it("gives a client's owners different first letters, the same way every time", () => {
    const taken: string[] = [];
    for (let i = 0; i < 6; i++) taken.push(nextOwnerName("tenant-a", taken));
    expect(new Set(taken.map((n) => n[0])).size).toBe(6);
    expect(taken[0]).toBe(nextOwnerName("tenant-a", []));
  });

  it("starts neighbouring clients at different places in the pool", () => {
    const firsts = new Set(
      ["a", "b", "c", "d", "e", "f"].map((t) => nextOwnerName(`tenant-${t}`, [])),
    );
    expect(firsts.size).toBeGreaterThan(1);
  });

  it("checks a client's rename", () => {
    expect(ownerNameProblem("Pip", ["Teo"])).toBeNull();
    expect(ownerNameProblem("José", [])).toBeNull();
    expect(ownerNameProblem("A", [])).toBe("length");
    expect(ownerNameProblem("Pia2", [])).toBe("letters");
    expect(ownerNameProblem("sloan", [])).toBe("reserved");
    expect(ownerNameProblem("teo", ["Teo"])).toBe("taken");
  });
});

describe("which settings a run uses", () => {
  it("without an area owner, is exactly v0.16's owner", () => {
    const r = runOwnerOf(v3(), undefined);
    expect(r.review).toBe("off");
    expect(r.area).toBeUndefined();
  });

  it("keeps a stored v3 process off unless the owner sets a review", () => {
    const off = runOwnerOf(v3(), pia({ model: { id: "xai:grok-4.7" } }));
    expect(off.review).toBe("off");
    expect(off.settings).toBeUndefined();
    const on = runOwnerOf(
      v3(),
      pia({ model: { id: "xai:grok-4.7" }, oversight: { review: "all" } }),
    );
    expect(on.review).toBe("all");
    expect(on.settings?.model?.id).toBe("xai:grok-4.7");
    expect(on.model.id).toBe("xai:grok-4.7");
    expect(on.area?.name).toBe("Pia");
  });

  it("lets the process's saved settings win, with the owner's model when it names none", () => {
    const r = runOwnerOf(
      v3({ review: "failures", maxPerRun: 1 }),
      pia({ model: { id: "openai:gpt-5.5" }, oversight: { review: "all" } }),
    );
    expect(r.review).toBe("failures");
    expect(r.maxPerRun).toBe(1);
    expect(r.model.id).toBe("openai:gpt-5.5");
    const own = runOwnerOf(
      v3({ review: "failures", model: { id: "claude-opus-5-5" } }),
      pia({ model: { id: "openai:gpt-5.5" } }),
    );
    expect(own.model.id).toBe("claude-opus-5-5");
  });

  it("starts a new owner with no model of its own, so each process keeps reviewing on its own", () => {
    expect(defaultOwnerDefinition()).toEqual({ notes: "" });
    const r = runOwnerOf(v3({ review: "failures" }), pia({}));
    expect(r.model.id).toBe("claude-haiku-5-5");
  });
});

describe("the signature", () => {
  it("signs with the name and the area's function, and Powered by under it", () => {
    expect(
      ownerSignature({
        name: "Pia",
        area: "purchasing",
        client: "Acme Supply",
        locale: "en",
        channel: "email",
        first: false,
      }),
    ).toEqual({
      signature: "Pia, purchasing agent for Acme Supply",
      poweredBy: "Powered by mezonas.com",
    });
    expect(
      ownerSignature({
        name: "Ivo",
        area: "general",
        client: "Acme",
        locale: "en",
        channel: "sms",
        first: false,
      }),
    ).toEqual({ signature: "Ivo, operations agent for Acme", poweredBy: null });
  });

  it("names mezonas.com in every language", () => {
    for (const l of LOCALES) expect(OWNER_WORDS[l].poweredBy).toContain("mezonas.com");
  });
});

describe("remember on a decision", () => {
  it("takes at most 2 short notes", () => {
    const ok = OversightDecision.safeParse({
      action: "continue",
      note: "Fine",
      remember: [{ note: "Acme puts the PO number in the footer" }],
    });
    expect(ok.success).toBe(true);
    const many = OversightDecision.safeParse({
      action: "continue",
      note: "Fine",
      remember: [{ note: "a" }, { note: "b" }, { note: "c" }],
    });
    expect(many.success).toBe(false);
  });

  it("is offered only to an area owner's review, so other requests don't change", () => {
    const plain = oversightFinishSchema("failed");
    expect(JSON.stringify(plain)).not.toContain("remember");
    const owner = oversightFinishSchema("failed", undefined, { remember: true });
    expect((owner as { properties: Record<string, unknown> }).properties.remember).toBeDefined();
  });
});
