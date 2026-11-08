// P-8: US texting registration (A2P 10DLC) by API through the running app, against the fake
// Twilio (docs/plan.md §1.70, M41). Never the live Twilio or a model. The client admin gives the
// details (the EIN write-only), the operator submits with the fees in view, the cron follows the
// statuses to a verified campaign; a brand and a campaign rejection are fixed and resubmitted;
// each fee is recorded once as the client's usage; texts go through the Messaging Service once
// verified and not before; the EIN is nowhere but the vault; clients stay apart.

import { createTwilioConnector, generateEncryptionKey } from "@countersign/connectors";
import {
  FAKE_PRIMARY_PROFILE,
  FAKE_TWILIO_MAIN,
  fakeTwilio,
} from "@countersign/connectors/testing";
import { PROVIDER_FEE_ENTITY } from "@countersign/core";
import {
  connectionChange,
  inboxItem,
  rawRecord,
  usagePlatformDaily,
  withTenant,
} from "@countersign/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  forbiddenKeys,
  OPERATOR,
  OTHER_OPERATOR,
  user,
} from "./api.test-helper";
import { A2P_CRON_MINUTE, A2P_SUBJECT, a2pCronTick } from "./messaging/a2p";
import { twilioTexter } from "./notify/mailer";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const ENCRYPTION_KEY = generateEncryptionKey();
const ORIGIN = "https://app.mezonas.test";
const twilio = fakeTwilio();
const EIN = "47-8812093";
const EIN_DIGITS = "478812093";

// Every line the code logs, to look for the EIN in.
const logged: string[] = [];
for (const level of process.env.SHOW_LOGS
  ? []
  : (["log", "info", "warn", "error", "debug"] as const)) {
  vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
    logged.push(
      args
        .map((a) => {
          try {
            return typeof a === "string" ? a : JSON.stringify(a, Object.getOwnPropertyNames(a));
          } catch {
            return String(a);
          }
        })
        .join(" "),
    );
  });
}

const h = await createApiHarness({
  connectors: () => [createTwilioConnector({ fetch: twilio.fetch })],
  env: {
    ENCRYPTION_KEY,
    APP_ORIGIN: ORIGIN,
    TWILIO_ACCOUNT_SID: FAKE_TWILIO_MAIN.accountSid,
    TWILIO_AUTH_TOKEN: FAKE_TWILIO_MAIN.authToken,
    TWILIO_PRIMARY_PROFILE_SID: FAKE_PRIMARY_PROFILE,
    TWILIO_A2P_EMAIL: "a2p@mezonas.test",
  },
  fetch: twilio.fetch,
});
afterAll(() => h?.close());

const DETAILS = {
  legalName: "Client A Millwork LLC",
  businessType: "Limited Liability Corporation",
  industry: "MANUFACTURING",
  companyType: "private",
  website: "https://client-a.example.com",
  address: {
    street: "100 Main St",
    city: "Austin",
    region: "TX",
    postalCode: "78701",
    country: "US",
  },
  representative: {
    firstName: "Dana",
    lastName: "Reyes",
    title: "Owner",
    position: "CEO",
    phone: "+15125550199",
    email: "dana@client-a.example.com",
  },
  volume: "low",
  uses: ["team", "vendors"],
  optIn:
    "Our team and vendors give us their mobile number on our onboarding form and tick a box agreeing to texts from Client A.",
  privacyPolicyUrl: "https://client-a.example.com/privacy",
  termsUrl: "https://client-a.example.com/terms",
};

/** A Twilio SID of any kind: none may reach the portal. */
const SID_RE = /\b(AC|BU|BN|MG|IT|AD|RD|QE|PN|EL|BV)[0-9a-fA-F]{32}\b/;

describe.skipIf(!h)("US texting registration by API", () => {
  const H = h as ApiHarness;
  const A = () => H.A.tenantId;
  const ops = (path = "", id = A()) => `/api/ops/clients/${id}${path}`;
  const responses: unknown[] = [];
  const call = async (...args: Parameters<ApiHarness["call"]>) => {
    const res = await H.call(...args);
    responses.push(res.json);
    return res;
  };
  const portalViews: unknown[] = [];
  const portal = async (who = admin("a")) => {
    const res = await call(who, "GET", "/api/texting-registration");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    portalViews.push(res.json);
    return j(res.json).registration;
  };
  const setup = async () => {
    const res = await call(OPERATOR, "GET", ops("/messaging"));
    expect(res.status).toBe(200);
    return j(res.json).setup;
  };
  const submit = async (body: Record<string, unknown> = {}, who = OPERATOR) =>
    call(who, "POST", ops("/messaging/a2p/submit"), {
      reason: "Client gave us their details",
      confirmFees: true,
      ...body,
    });
  /** The cron's hourly pass, at its minute. */
  const cron = async () => {
    const at = new Date();
    at.setUTCMinutes(A2P_CRON_MINUTE, 0, 0);
    await a2pCronTick(H.db, { env: H.env, fetch: twilio.fetch }, at);
  };
  const fees = () =>
    H.t.db
      .select({ key: rawRecord.externalId, payload: rawRecord.payload })
      .from(rawRecord)
      .where(and(eq(rawRecord.tenantId, A()), eq(rawRecord.entityType, PROVIDER_FEE_ENTITY)));
  const notices = () =>
    H.t.db
      .select()
      .from(inboxItem)
      .where(and(eq(inboxItem.tenantId, A()), eq(inboxItem.subjectType, A2P_SUBJECT)));
  const texter = () => twilioTexter({ fetch: twilio.fetch, secrets: H.env });
  let numberSid = "";

  beforeAll(async () => {
    for (const id of [H.A.tenantId, H.B.tenantId]) {
      const p = await H.call(OPERATOR, "POST", ops("/messaging/twilio", id));
      expect(p.status, JSON.stringify(p.json)).toBe(200);
    }
    const bought = await H.call(OPERATOR, "POST", ops("/messaging/numbers"), {
      phoneNumber: "+15125550101",
    });
    expect(bought.status, JSON.stringify(bought.json)).toBe(200);
    numberSid = j(bought.json).setup.twilio.numbers[0].sid;
  });

  it("lets only the client admin give the details; the EIN is write-only; marketing is refused", async () => {
    const empty = await portal();
    expect(empty).toMatchObject({ available: true, stage: "draft", details: null, einSet: false });
    expect((await call(user("a"), "GET", "/api/texting-registration")).status).toBe(403);
    expect(
      (await call(user("a"), "PUT", "/api/texting-registration", { details: DETAILS, ein: EIN }))
        .status,
    ).toBe(403);

    const marketing = await call(admin("a"), "PUT", "/api/texting-registration", {
      details: { ...DETAILS, uses: ["team", "marketing"] },
    });
    expect(marketing.status).toBe(422);
    expect(j(marketing.json).error.code).toBe("marketing_refused");
    const badEin = await call(admin("a"), "PUT", "/api/texting-registration", {
      details: DETAILS,
      ein: "12-34",
    });
    expect(j(badEin.json).error.code).toBe("invalid_ein");

    const saved = await call(admin("a"), "PUT", "/api/texting-registration", {
      details: DETAILS,
      ein: EIN,
    });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    expect(j(saved.json).registration).toMatchObject({
      stage: "draft",
      einSet: true,
      einHint: "••-•••••93",
      editable: true,
    });
    // The change log names the fields, never the EIN.
    const changes = await H.t.db
      .select({ change: connectionChange.change })
      .from(connectionChange)
      .where(eq(connectionChange.tenantId, A()));
    expect(JSON.stringify(changes)).toContain('"ein":"set"');
  });

  it("shows the operator the fees before submitting, and only the operator can submit", async () => {
    const s = await setup();
    expect(s.twilio.registration).toMatchObject({
      stage: "draft",
      missing: [],
      brandType: "low_volume",
      useCase: "LOW_VOLUME",
      fees: { nowUsd: "19.0000" },
    });
    expect(s.twilio.registration.fees.lines.map((l: { kind: string }) => l.kind)).toEqual([
      "brand",
      "vetting",
      "monthly",
    ]);
    expect(s.twilio.a2p.registration).toBeUndefined();
    expect((await submit({}, admin("a"))).status).toBe(403);
    expect((await submit({}, OTHER_OPERATOR)).status).toBe(404);
    const unconfirmed = await call(OPERATOR, "POST", ops("/messaging/a2p/submit"), {
      reason: "go",
    });
    expect(unconfirmed.status).toBe(400);
    const promo = await submit({
      campaign: {
        description: "Client A sends a weekly discount and promo codes to its customers.",
        samples: [
          "Client A: 20% discount this week only!",
          "Client A: use promo code SAVE20 today",
        ],
        messageFlow: DETAILS.optIn,
      },
    });
    expect(promo.status).toBe(422);
    expect(j(promo.json).error.code).toBe("marketing_refused");
    expect(twilio.a2p.charged).toEqual([]);
  });

  it("submits: profile, trust product, service and brand; one brand fee; US texts still refused", async () => {
    const res = await submit();
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const reg = j(res.json).setup.twilio.registration;
    expect(reg).toMatchObject({
      stage: "submitted",
      statuses: {
        customerProfile: "pending-review",
        trustProduct: "pending-review",
        brand: "PENDING",
      },
      issues: [],
    });
    expect(reg.submissions[0]).toMatchObject({
      reason: "Client gave us their details",
      by: "Operator",
    });
    expect(twilio.a2p.charged.map((c) => c.kind)).toEqual(["brand"]);
    // The EIN went to Twilio in the business's end user, and nowhere of ours shows it.
    const business = [...twilio.a2p.endUsers.values()].find(
      (e) => e.type === "customer_profile_business_information",
    );
    expect(business?.attributes.business_registration_number).toBe(EIN);
    expect((await fees()).map((f) => f.key)).toEqual([`a2p:brand:${reg.sids.brand}`]);
    // The cron changes nothing while the brand is pending; no fee twice.
    await cron();
    await cron();
    expect((await fees()).length).toBe(1);
    expect((await setup()).twilio.registration.stage).toBe("submitted");
    // Before the campaign is verified, US texts are refused.
    const from = await withTenant(H.db, A(), (tx) => texter().from(tx, A()));
    expect(from).toBeNull();
    expect((await portal()).editable).toBe(false);
  });

  it("a brand rejection comes with Twilio's reason; after an edit the operator resubmits", async () => {
    const s = await setup();
    twilio.setBrandResult(s.twilio.registration.sids.brand, "FAILED", [
      {
        error_code: 30794,
        fields: ["business_name"],
        description: `Tax ID ${EIN} does not match the legal name`,
      },
    ]);
    await cron();
    const failed = (await setup()).twilio.registration;
    expect(failed.stage).toBe("needs_changes");
    expect(failed.issues[0]).toMatchObject({ source: "brand", code: "30794" });
    // Twilio's text is kept with the EIN taken out.
    expect(failed.issues[0].description).toBe("Tax ID [EIN] does not match the legal name");
    expect(failed.issues[0].words).toContain("Check the legal name");
    const view = await portal();
    expect(view).toMatchObject({ stage: "needs_changes", editable: true });
    expect(view.needs[0]).toContain("Check the legal name");
    const items = await notices();
    expect(items.map((i) => [i.assigneeRole, i.title, i.status]).sort()).toEqual([
      ["client_admin", "Twilio needs changes to your texting registration", "open"],
      ["operator", "Twilio needs changes to your texting registration", "open"],
    ]);
    // A brand resubmit costs nothing new (Twilio: three updates are free).
    expect(failed.fees.lines.map((l: { kind: string }) => l.kind)).toEqual(["vetting", "monthly"]);

    const edited = await call(admin("a"), "PUT", "/api/texting-registration", {
      details: { ...DETAILS, legalName: "Client A Millwork, LLC" },
    });
    expect(edited.status, JSON.stringify(edited.json)).toBe(200);
    expect(j(edited.json).registration.einSet).toBe(true);
    const again = await submit({ reason: "Legal name fixed as on the EIN letter" });
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    const reg = j(again.json).setup.twilio.registration;
    expect(reg).toMatchObject({ stage: "submitted", brandUpdates: 1, issues: [] });
    expect(business()?.attributes.business_name).toBe("Client A Millwork, LLC");
    expect(twilio.a2p.charged.map((c) => c.kind)).toEqual(["brand"]);
    expect((await fees()).length).toBe(1);
  });

  it("makes the campaign once the brand is approved; one vetting fee however often the cron runs", async () => {
    const s = await setup();
    twilio.setBrand(s.twilio.registration.sids.brand, "APPROVED");
    await cron();
    await cron();
    const reg = (await setup()).twilio.registration;
    expect(reg).toMatchObject({
      stage: "campaign",
      campaignAttempts: 1,
      statuses: { brand: "APPROVED" },
    });
    const campaign = twilio.a2p.campaignRecords.get(reg.sids.messagingService);
    expect(campaign?.usecase).toBe("LOW_VOLUME");
    expect(campaign?.samples.every((x) => x.includes("Client A Millwork, LLC"))).toBe(true);
    expect((await fees()).map((f) => f.key)).toContain(
      `a2p:vetting:${reg.sids.messagingService}:1`,
    );
    expect((await fees()).length).toBe(2);
  });

  it("a campaign rejection: Twilio's reason, an edit of the words, a resubmit with a new vetting fee", async () => {
    const service = (await setup()).twilio.registration.sids.messagingService;
    twilio.setCampaign(service, "FAILED", [
      {
        error_code: 30893,
        fields: ["SAMPLE_MESSAGE_1"],
        url: "https://www.twilio.com/docs/api/errors/30893",
        description: "Sample messages don't match the use case.",
      },
    ]);
    await cron();
    const failed = (await setup()).twilio.registration;
    expect(failed.stage).toBe("needs_changes");
    expect(failed.issues[0].words).toBe(
      "Sample messages don't match the use case. Check the first sample message.",
    );
    expect(failed.fees.lines.map((l: { kind: string; label: string }) => l.kind)).toEqual([
      "vetting",
      "monthly",
    ]);
    const words = {
      ...failed.campaign,
      samples: [
        "Client A Millwork, LLC: Mezonas code: [code]. Enter it to let [agent] use [tool]. Reply STOP to opt out.",
        "Hi [vendor], this is [agent] for Client A Millwork, LLC. Please send the invoice for PO [number]. Reply STOP to opt out.",
      ],
    };
    const res = await submit({ reason: "Samples rewritten", campaign: words });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const reg = j(res.json).setup.twilio.registration;
    expect(reg).toMatchObject({ stage: "campaign", campaignAttempts: 2, campaignEdited: true });
    expect(twilio.a2p.campaignRecords.get(service)?.samples).toEqual(words.samples);
    // The profile and brand were left alone (no brand update for a campaign's rejection).
    expect(reg.brandUpdates).toBe(1);
    expect(twilio.a2p.charged.map((c) => c.kind)).toEqual(["brand", "vetting", "vetting"]);
    expect((await fees()).map((f) => f.key)).toContain(`a2p:vetting:${service}:2`);
  });

  it("once verified: numbers join the service, texting is ready, the month's fee once, texts go through it", async () => {
    const service = (await setup()).twilio.registration.sids.messagingService;
    twilio.setCampaign(service, "VERIFIED");
    await cron();
    await cron();
    const s = await setup();
    expect(s.twilio.a2p.status).toBe("approved");
    expect(s.twilio.registration).toMatchObject({ stage: "ready", serviceNumbers: [numberSid] });
    expect([...(twilio.a2p.services.get(service)?.numbers ?? [])]).toEqual([numberSid]);
    const all = await fees();
    expect(all.length).toBe(4);
    const month = new Date().toISOString().slice(0, 7);
    expect(all.map((f) => f.key)).toContain(`a2p:monthly:${service}:${month}`);
    // Fees as the client's usage: $4 + $15 + $15 + $1.50, counted once each.
    const [usage] = await H.t.db
      .select({ cost: sql<string>`sum(${usagePlatformDaily.costUsd})::text` })
      .from(usagePlatformDaily)
      .where(eq(usagePlatformDaily.tenantId, A()));
    expect(usage?.cost).toBe("35.5000");
    // People are told; the older notice is closed.
    const items = await notices();
    const open = items.filter((i) => i.status === "open");
    expect(open.map((i) => [i.assigneeRole, i.title]).sort()).toEqual([
      ["client_admin", "Texting is ready"],
      ["operator", "Texting is ready"],
    ]);
    // Texts now go through the Messaging Service, From the client's number.
    const before = twilio.sends().length;
    await withTenant(H.db, A(), async (tx) => {
      const t = texter();
      expect(await t.from(tx, A())).toBe("+15125550101");
      await t.send(tx, A(), { to: "+15555550100", body: "Client A: your order is ready" });
    });
    expect(twilio.sends()[before]?.form).toMatchObject({
      From: "+15125550101",
      MessagingServiceSid: service,
    });
    // A number bought now joins the service too.
    const bought = await call(OPERATOR, "POST", ops("/messaging/numbers"), {
      phoneNumber: "+15125550102",
    });
    expect(bought.status, JSON.stringify(bought.json)).toBe(200);
    const second = j(bought.json).setup.twilio.numbers[1].sid;
    expect(j(bought.json).setup.twilio.registration.serviceNumbers).toEqual([numberSid, second]);
    expect(twilio.a2p.services.get(service)?.numbers.has(second)).toBe(true);
    const view = await portal();
    expect(view).toMatchObject({ stage: "ready", editable: false, needs: [] });
  });

  it("keeps clients apart: another client sees only its own (empty) registration", async () => {
    const b = await portal(admin("b"));
    expect(b).toMatchObject({ stage: "draft", details: null, einSet: false });
    const bSetup = await call(OPERATOR, "GET", ops("/messaging", H.B.tenantId));
    expect(j(bSetup.json).setup.twilio.registration.stage).toBe("draft");
    // Client C's operator can't reach A's.
    expect((await call(OTHER_OPERATOR, "GET", ops("/messaging"))).status).toBe(404);
    // B's subaccount can't read A's Trust Hub bundles either (the fake enforces it).
  });

  it("answers the portal with no SID, fee or cost, and the EIN is nowhere: responses, logs or rows", async () => {
    for (const v of portalViews) {
      expect(forbiddenKeys(v, /fee|amount|usd|sid/i)).toEqual([]);
      expect(SID_RE.test(JSON.stringify(v))).toBe(false);
    }
    await call(OPERATOR, "GET", `/api/ops/inbox?client=${A()}`);
    await call(admin("a"), "GET", "/api/inbox");
    const tables = await H.t.db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    const dump: string[] = [];
    for (const { table_name } of tables) {
      const rows = await H.t.db.execute<{ row: unknown }>(
        sql`select to_jsonb(t) as row from ${sql.identifier(table_name)} t`,
      );
      dump.push(JSON.stringify(rows));
    }
    const places = {
      responses: JSON.stringify(responses),
      logs: logged.join("\n"),
      database: dump.join("\n"),
    };
    for (const [where, text] of Object.entries(places)) {
      expect(text.includes(EIN), `EIN found in ${where}`).toBe(false);
      expect(text.includes(EIN_DIGITS), `EIN found in ${where}`).toBe(false);
    }
  });
});

function business() {
  return [...twilio.a2p.endUsers.values()].find(
    (e) => e.type === "customer_profile_business_information",
  );
}
