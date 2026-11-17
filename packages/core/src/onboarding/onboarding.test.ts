// Onboarding v1's contract (docs/plan.md §1.125): the client file's facts, what an intake covers,
// the guide's field values, the route bodies' rules, and the portal's views carrying nothing of
// ours. The guide's building and the emails are other streams' (stubs here, which throw).

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { clientFileRoutes, startRoutes } from "../api/client-files";
import { checkRouteContract, forbiddenPortalFields, routeFamily } from "../api/contract";
import {
  opsIntakeRoutes,
  PortalIntakeView,
  portalIntakeRoutes,
  welcomeRoutes,
} from "../api/intake";
import { InviteDraft, inviteRoutes, SignUpNowDraft } from "../api/invite";
import { routes } from "../api/routes";
import { renderBrandedEmail } from "../email/layout";
import { renderInviteEmail } from "../email/onboarding";
import {
  buildGuide,
  Covers,
  coversAnything,
  currentFacts,
  fieldValueSchema,
  GUIDE_FIELD_KINDS,
  guideProgress,
  guideTotals,
  INTAKE_AREAS,
  mergeFields,
  NewClientFact,
  sectionKeysOf,
  theirFacts,
  WelcomeLinkToken,
} from "./index";

const T1 = "0192f0aa-0000-7000-8000-000000000001";
const T2 = "0192f0aa-0000-7000-8000-000000000002";

describe("the client file's facts", () => {
  const facts = [
    { id: "a", fileId: "f", replacesId: null, audience: "theirs" as const },
    { id: "b", fileId: "f", replacesId: "a", audience: "theirs" as const },
    { id: "c", fileId: "f", replacesId: null, audience: "ours" as const },
    // A replacement naming another file's fact changes nothing.
    { id: "d", fileId: "g", replacesId: "c", audience: "theirs" as const },
  ];

  it("keep only the facts no later one corrects", () => {
    expect(currentFacts(facts).map((f) => f.id)).toEqual(["b", "c", "d"]);
  });

  it("show the client only current facts about their business", () => {
    expect(theirFacts(facts).map((f) => f.id)).toEqual(["b", "d"]);
  });

  it("start as our notes, heard, unless said otherwise", () => {
    const f = NewClientFact.parse({ section: "volumes", text: "340 bills", sourceKind: "call" });
    expect(f).toMatchObject({ audience: "ours", sureness: "heard", sources: [] });
    expect(() =>
      NewClientFact.parse({ section: "volumes", text: "x".repeat(2001), sourceKind: "call" }),
    ).toThrow();
  });
});

describe("what an intake covers", () => {
  it("offers every area but general, and names nothing twice", () => {
    expect(INTAKE_AREAS).not.toContain("general");
    expect(INTAKE_AREAS).toContain("receivables");
    expect(() =>
      Covers.parse({ general: true, areas: ["purchasing", "purchasing"], templateIds: [] }),
    ).toThrow();
    expect(() => Covers.parse({ general: true, areas: [], templateIds: [T1, T1] })).toThrow();
  });

  it("is nothing at all for Just the account", () => {
    expect(coversAnything({ general: false, areas: [], templateIds: [] })).toBe(false);
    expect(coversAnything({ general: false, areas: ["bookkeeping"], templateIds: [] })).toBe(true);
  });

  it("orders the guide's sections general, areas, agents", () => {
    expect(sectionKeysOf({ general: true, areas: ["purchasing"], templateIds: [T1] })).toEqual([
      "general",
      "area:purchasing",
      `agent:${T1}`,
    ]);
  });
});

describe("a field's value", () => {
  it("is checked against its kind", () => {
    expect(fieldValueSchema("money").safeParse({ amount: "5000", currency: "USD" }).success).toBe(
      true,
    );
    expect(fieldValueSchema("money").safeParse(5000).success).toBe(false);
    expect(fieldValueSchema("date").safeParse("2026-12-24").success).toBe(true);
    expect(fieldValueSchema("yes_no").safeParse("yes").success).toBe(false);
    expect(fieldValueSchema("tool").safeParse({ connectionId: T1 }).success).toBe(true);
    for (const kind of GUIDE_FIELD_KINDS) expect(fieldValueSchema(kind)).toBeDefined();
  });
});

describe("Invite and Sign up now's bodies", () => {
  const person = { name: "Dana Ruiz", email: "Dana@Acme.com", isAdmin: true };
  const covers = { general: true, areas: ["purchasing"], templateIds: [T1] };

  it("need a company, one admin on a new account, and each person once", () => {
    expect(InviteDraft.parse({ company: "Acme", people: [person], covers }).people[0]?.email).toBe(
      "dana@acme.com",
    );
    expect(InviteDraft.safeParse({ people: [person], covers }).success).toBe(false);
    expect(
      InviteDraft.safeParse({ company: "Acme", people: [{ ...person, isAdmin: false }], covers })
        .success,
    ).toBe(false);
    // More people at an existing client need no admin.
    expect(
      InviteDraft.safeParse({ clientId: T2, people: [{ ...person, isAdmin: false }], covers })
        .success,
    ).toBe(true);
    expect(
      InviteDraft.safeParse({ company: "Acme", people: [person, person], covers }).success,
    ).toBe(false);
  });

  it("take a price as a decimal string, never a number", () => {
    const base = { company: "Acme", person: { name: "Dana", email: "d@acme.com" }, startId: T1 };
    expect(SignUpNowDraft.safeParse({ ...base, agreedMrr: "1500.00" }).success).toBe(true);
    expect(SignUpNowDraft.safeParse({ ...base, agreedMrr: 1500 }).success).toBe(false);
    expect(SignUpNowDraft.safeParse({ ...base, agreedMrr: "-1" }).success).toBe(false);
  });
});

describe("the onboarding routes", () => {
  const all = {
    ...clientFileRoutes,
    ...startRoutes,
    ...inviteRoutes,
    ...opsIntakeRoutes,
    ...portalIntakeRoutes,
    ...welcomeRoutes,
  };

  it("are in the contract and keep its rules", () => {
    expect(checkRouteContract(all)).toEqual([]);
    for (const [name, r] of Object.entries(all)) {
      expect((routes as Record<string, unknown>)[name], name).toBe(r);
    }
  });

  it("keep files, facts, starts and invites in the back office", () => {
    for (const r of [
      ...Object.values(clientFileRoutes),
      ...Object.values(startRoutes),
      ...Object.values(inviteRoutes),
      ...Object.values(opsIntakeRoutes),
    ]) {
      expect(routeFamily(r)).toBe("ops");
    }
  });

  it("show the client no fact ids, no question's origin and nothing of ours", () => {
    for (const r of [...Object.values(portalIntakeRoutes), ...Object.values(welcomeRoutes)]) {
      expect(forbiddenPortalFields(r.response)).toEqual([]);
    }
    const json = JSON.stringify(
      z.toJSONSchema(PortalIntakeView, { io: "output", unrepresentable: "any" }),
    );
    expect(json).not.toContain("factIds");
    expect(json).not.toContain("origin");
  });

  it("sign a welcome link over the client, intake, person and expiry only", () => {
    expect(WelcomeLinkToken.safeParse({ t: T1, i: T2, p: T1, e: 1_800_000_000 }).success).toBe(
      true,
    );
    expect(WelcomeLinkToken.safeParse({ t: T1, i: T2, e: 1 }).success).toBe(false);
  });
});

describe("the other streams' seams", () => {
  it("throw until built", () => {
    const covers = { general: true, areas: [], templateIds: [] };
    expect(() => buildGuide({ covers, general: null, areas: [], agents: [], facts: [] })).toThrow(
      /stream INTAKE/,
    );
    expect(() => mergeFields([])).toThrow(/stream INTAKE/);
    expect(() => guideTotals([])).toThrow(/stream INTAKE/);
    expect(() =>
      guideProgress(
        {
          version: 1,
          sections: [],
          totals: { known: 0, toConfirm: 0, toAsk: 0, later: 0, tools: 0, minutes: 0 },
        },
        [],
      ),
    ).toThrow(/stream INTAKE/);
    expect(() =>
      renderBrandedEmail({
        locale: "en",
        subject: "x",
        from: { name: "Jammil", photoUrl: null },
        blocks: [],
        origin: "https://app.mezonas.com",
      }),
    ).toThrow(/stream EMAIL/);
    expect(() =>
      renderInviteEmail({
        locale: "en",
        client: "Acme",
        to: { name: "Dana", email: "d@acme.com" },
        lead: { name: "Jammil", photoUrl: null },
        link: "https://app.mezonas.com/start/x",
        expiresAt: new Date(),
        origin: "https://app.mezonas.com",
        note: "",
        summary: { general: true, areas: [], agents: 0, minutes: 10 },
      }),
    ).toThrow(/stream EMAIL/);
  });
});
