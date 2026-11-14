// Reggie, step 2 (docs/plan.md §1.101): setting a client up from the back office with cards the
// operator confirms: create the client, give it an agent from a template, set up texting and buy
// a number, ask the admin for their US texting details, submit the registration with its fees,
// and invite its people to texts. Over fake Twilio and Resend, with scripted model answers.
import {
  createResendConnector,
  createTwilioConnector,
  type FetchLike,
  generateEncryptionKey,
  RESEND_API,
} from "@countersign/connectors";
import {
  FAKE_PRIMARY_PROFILE,
  FAKE_RESEND_MAIN,
  FAKE_TWILIO_MAIN,
  fakeResend,
  fakeTwilio,
} from "@countersign/connectors/testing";
import { agent, inboxItem, membership, tenant } from "@countersign/db";
import { FakeModel, type FakeTurn } from "@countersign/llm";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { admin, createApiHarness, OPERATOR, testBundle } from "./api.test-helper";
import { REGISTRATION_REQUEST } from "./reggie/tools";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error", "log"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const twilio = fakeTwilio();
const resend = fakeResend();
const emails: { to: string[]; subject: string }[] = [];
const fetch: FetchLike = (url, init) => {
  if (url.startsWith(RESEND_API)) {
    if (init?.body && url.endsWith("/emails")) emails.push(JSON.parse(init.body));
    return resend.fetch(url, init);
  }
  return twilio.fetch(url, init);
};
const model = new FakeModel();
const h = await createApiHarness({
  llm: model,
  connectors: () => [
    createTwilioConnector({ fetch: twilio.fetch }),
    createResendConnector({ fetch: resend.fetch }),
  ],
  env: {
    ENCRYPTION_KEY: generateEncryptionKey(),
    APP_ORIGIN: "https://app.mezonas.test",
    TWILIO_ACCOUNT_SID: FAKE_TWILIO_MAIN.accountSid,
    TWILIO_AUTH_TOKEN: FAKE_TWILIO_MAIN.authToken,
    TWILIO_PRIMARY_PROFILE_SID: FAKE_PRIMARY_PROFILE,
    TWILIO_A2P_EMAIL: "a2p@mezonas.test",
    RESEND_API_KEY: FAKE_RESEND_MAIN.apiKey,
    RESEND_FALLBACK_DOMAIN: "mail.mezonas.test",
  },
  fetch,
});
afterAll(() => h?.close());

/** The last tool result the model was given. */
function lastResult(): string {
  const last = model.requests.at(-1)?.messages.at(-1)?.content;
  if (!Array.isArray(last)) return "";
  const block = last.find((b) => b.type === "tool_result");
  return block && block.type === "tool_result" ? String(block.content) : "";
}

const use = (name: string, input: unknown): FakeTurn => ({ toolUse: { name, input } });
const say = (text: string): FakeTurn => ({ text });

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
    "Our team signs up for texts on our sign-up page by ticking an unticked box beside the words they agree to.",
  privacyPolicyUrl: "https://client-a.example.com/privacy",
  termsUrl: "https://client-a.example.com/terms",
};

describe.skipIf(!h)("Reggie sets a client up", () => {
  const H = h as NonNullable<typeof h>;
  const A = () => H.A.tenantId;
  let conversation = "";

  /** One turn that proposes `name(input)`; the card it made. */
  async function propose(name: string, input: unknown) {
    model.push(use(name, input), say("Proposed: confirm the card."));
    const res = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/reggie/conversations/${conversation}/turns`,
      {
        text: `Please ${name}`,
      },
    );
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const cards = j(res.json).actions as {
      id: string;
      tool: string;
      status: string;
      lines: string[];
    }[];
    const card = cards.filter((a) => a.tool === name && a.status === "proposed").at(-1);
    return {
      card,
      toolResult: lastResult(),
    };
  }
  const confirm = async (id: string) => {
    const res = await H.call(OPERATOR, "POST", `/api/ops/reggie/actions/${id}/confirm`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return j(res.json).action as { status: string; outcome: string | null };
  };

  it("starts a conversation", async () => {
    const res = await H.call(OPERATOR, "POST", "/api/ops/reggie/conversations", {});
    conversation = j(res.json).conversation.id;
    expect(conversation).toBeTruthy();
  });

  it("creates a client and invites its admin, served by the operator", async () => {
    const { card } = await propose("client_create", {
      name: "Rivera Supply",
      timezone: "America/Chicago",
      adminEmail: "dana@rivera.example.com",
      adminName: "Dana Rivera",
    });
    expect(card?.lines).toEqual([
      "A new client, served by you:",
      "Rivera Supply",
      "Time zone: America/Chicago",
      "Invite Dana Rivera (dana@rivera.example.com) as its admin.",
    ]);
    expect(await H.t.db.select().from(tenant).where(eq(tenant.name, "Rivera Supply"))).toHaveLength(
      0,
    );
    const done = await confirm(card?.id as string);
    expect(done.outcome).toBe("Created Rivera Supply and invited its admin.");
    const [row] = await H.t.db.select().from(tenant).where(eq(tenant.name, "Rivera Supply"));
    expect(row?.timezone).toBe("America/Chicago");
    const members = await H.t.db
      .select({ role: membership.role })
      .from(membership)
      .where(eq(membership.tenantId, row?.id as string));
    expect(members.map((m) => m.role).sort()).toEqual(["client_admin", "operator"]);
  });

  it("gives a client an agent from a template, with approval on", async () => {
    const created = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "bill-helper",
      bundle: testBundle("Bill helper"),
      releaseNote: "First",
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const templateId = j(created.json).agent.id as string;
    const published = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${templateId}/versions/${j(created.json).version.id}/publish`,
    );
    expect(published.status, JSON.stringify(published.json)).toBe(200);
    const before = await H.t.db.select().from(agent).where(eq(agent.tenantId, A()));
    model.push(use("templates_list", {}), say("Here they are."));
    await H.call(OPERATOR, "POST", `/api/ops/reggie/conversations/${conversation}/turns`, {
      text: "Which templates are there?",
    });
    const listed = lastResult();
    expect(listed).toContain(templateId);
    const { card } = await propose("agent_add", { client: A(), templateId, serviceName: "Bills" });
    expect(card?.lines).toContain("Every write starts with approval on.");
    const done = await confirm(card?.id as string);
    expect(done.status).toBe("done");
    expect(done.outcome).toBe("Client A has its own Bill helper.");
    const after = await H.t.db.select().from(agent).where(eq(agent.tenantId, A()));
    expect(after.length).toBe(before.length + 1);
  });

  it("sets up texting and buys a number, each only once confirmed", async () => {
    const { card } = await propose("texting_setup", { client: A() });
    expect(
      j((await H.call(OPERATOR, "GET", `/api/ops/clients/${A()}/messaging`)).json).setup.twilio,
    ).toBeNull();
    await confirm(card?.id as string);
    const setup = j(
      (await H.call(OPERATOR, "GET", `/api/ops/clients/${A()}/messaging`)).json,
    ).setup;
    expect(setup.twilio.status).toBe("connected");

    const buy = await propose("texting_number_buy", { client: A(), phoneNumber: "+15125550101" });
    expect(buy.card?.lines[0]).toContain("Twilio charges for the number every month.");
    await confirm(buy.card?.id as string);
    const after = j(
      (await H.call(OPERATOR, "GET", `/api/ops/clients/${A()}/messaging`)).json,
    ).setup;
    expect(after.twilio.numbers.map((n: { phoneNumber: string }) => n.phoneNumber)).toContain(
      "+15125550101",
    );
  });

  it("asks the admin for their texting details in fixed words, and won't submit before them", async () => {
    const early = await propose("texting_registration_submit", {
      client: A(),
      reason: "First submit",
    });
    expect(early.card).toBeUndefined();
    expect(early.toolResult).toMatch(/^(no_details|details_missing):/);

    const { card } = await propose("texting_registration_request", { client: A() });
    expect(card?.lines.slice(1)).toEqual([
      REGISTRATION_REQUEST.question,
      REGISTRATION_REQUEST.detail,
    ]);
    await confirm(card?.id as string);
    const [item] = await H.t.db
      .select()
      .from(inboxItem)
      .where(and(eq(inboxItem.tenantId, A()), eq(inboxItem.title, REGISTRATION_REQUEST.question)));
    expect(item).toMatchObject({ kind: "request", assigneeRole: "client_admin" });
  });

  it("submits the registration with its fees on the card, once the admin gave the details", async () => {
    const saved = await H.call(admin("a"), "PUT", "/api/texting-registration", {
      details: DETAILS,
      ein: "47-8812093",
    });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    const { card } = await propose("texting_registration_submit", {
      client: A(),
      reason: "Client gave their details",
    });
    expect(card?.lines.join("\n")).toMatch(/Charged now: \$\d+\.\d+/);
    expect(card?.lines).toContain("Reason: Client gave their details");
    // The tax id never reaches the model or the card.
    expect(JSON.stringify(model.requests)).not.toContain("8812093");
    expect(card?.lines.join("\n")).not.toContain("8812093");
    const done = await confirm(card?.id as string);
    expect(done.status, done.outcome ?? "").toBe("done");
    const reg = j((await H.call(OPERATOR, "GET", `/api/ops/clients/${A()}/messaging`)).json).setup
      .twilio.registration;
    expect(reg.submissions.at(-1)).toMatchObject({ reason: "Client gave their details" });
  });

  it("invites a client's people to texts in the client's name", async () => {
    const made = await H.call(admin("a"), "POST", "/api/contacts", {
      name: "Pat Lee",
      email: "pat@vendor.example",
    });
    const pat = j(made.json).contact.id as string;
    model.push(use("people_list", { client: A() }), say("Pat Lee is there."));
    await H.call(OPERATOR, "POST", `/api/ops/reggie/conversations/${conversation}/turns`, {
      text: "Who's at Client A?",
    });
    expect(lastResult()).toContain(pat);
    const { card } = await propose("texting_invitations_send", { client: A(), people: [pat] });
    expect(card?.lines[1]).toBe("Pat Lee");
    expect(emails.filter((e) => e.to.includes("pat@vendor.example"))).toHaveLength(0);
    const done = await confirm(card?.id as string);
    expect(done.outcome).toBe("Invited 1 at Client A.");
    expect(emails.filter((e) => e.to.includes("pat@vendor.example"))).toHaveLength(1);
  });
});
