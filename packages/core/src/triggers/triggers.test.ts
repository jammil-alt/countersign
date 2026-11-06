import { describe, expect, it } from "vitest";
import { Workflow } from "../schemas/workflow";
import { triggerSchema } from "../template/typer";
import { validateWorkflow } from "../workflow/validate";
import { agentAddress, parseAgentAddress, sameAgentAddress } from "./address";
import { INBOUND_TEXT_MAX, inboundText } from "./inbound";
import { acceptingTriggers, acceptsSloan, passToAgentEvent } from "./kinds";
import { matchesPeople } from "./people";

const CLIENT = "0192f7a0-0000-7000-8000-00000000c00a";
const OTHER = "0192f7a0-0000-7000-8000-00000000c00b";
const CONTACT = "0192f7a0-0000-7000-8000-000000000c01";
const DOMAIN = "in.mezonas.test";

describe("the agent's address", () => {
  it("round-trips the client and the command name, and refuses anything else", () => {
    const a = agentAddress({
      commandName: "remy",
      clientName: "Ana's Millwork, Inc.",
      tenantId: CLIENT,
      domain: DOMAIN,
    });
    expect(a).toMatch(/^remy\.anas-millwork-in-[a-z2-7]{26}@in\.mezonas\.test$/);
    expect(parseAgentAddress(a, DOMAIN)).toEqual({
      tenantId: CLIENT,
      commandName: "remy",
      label: "anas-millwork-in",
    });
    expect(parseAgentAddress(a.toUpperCase(), DOMAIN)?.tenantId).toBe(CLIENT);
    expect(parseAgentAddress(a, "other.test")).toBeNull();
    expect(parseAgentAddress(`x${"-".repeat(300)}@${DOMAIN}`, DOMAIN)).toBeNull();
    expect(parseAgentAddress(`remy-abc@${DOMAIN}`, DOMAIN)).toBeNull();
    // Another client's id with this client's label is a different address.
    const forged = agentAddress({
      commandName: "remy",
      clientName: "Ana's Millwork, Inc.",
      tenantId: OTHER,
      domain: DOMAIN,
    });
    expect(sameAgentAddress(forged, a)).toBe(false);
    expect(sameAgentAddress(a.replace("@", "+x@"), a)).toBe(true);
  });
});

describe("People filters", () => {
  const filter = { tags: ["Cardholder"], clientRoles: ["client_admin" as const] };
  it("takes a listed contact, tag, relationship or role; nobody else", () => {
    expect(
      matchesPeople(filter, {
        kind: "contact",
        contactId: CONTACT,
        relationship: null,
        tags: ["cardholder"],
      }),
    ).toBe(true);
    expect(
      matchesPeople(filter, {
        kind: "contact",
        contactId: CONTACT,
        relationship: "employee",
        tags: [],
      }),
    ).toBe(false);
    expect(
      matchesPeople(
        { relationships: ["employee"] },
        { kind: "contact", contactId: CONTACT, relationship: "employee", tags: [] },
      ),
    ).toBe(true);
    expect(
      matchesPeople(
        { contactIds: [CONTACT] },
        { kind: "contact", contactId: CONTACT, relationship: null, tags: [] },
      ),
    ).toBe(true);
    expect(matchesPeople(filter, { kind: "user", userId: CONTACT, role: "client_admin" })).toBe(
      true,
    );
    expect(matchesPeople(filter, { kind: "user", userId: CONTACT, role: "client_user" })).toBe(
      false,
    );
    expect(matchesPeople({}, { kind: "user", userId: CONTACT, role: "operator" })).toBe(true);
    expect(matchesPeople(filter, { kind: "stranger" })).toBe(false);
    expect(
      matchesPeople({}, { kind: "contact", contactId: CONTACT, relationship: null, tags: [] }),
    ).toBe(false);
  });
});

describe("inbound text", () => {
  it("keeps the sender's own words: quoted history cut, cards redacted, 4,000 characters", () => {
    const body =
      "Please log this charge.\nCard 4111 1111 1111 1111\r\n\nOn Mon, Nov 2, Ana wrote:\n> old";
    const text = inboundText(body);
    expect(text).toContain("Please log this charge.");
    expect(text).not.toContain("4111 1111 1111 1111");
    expect(text).not.toContain("old");
    expect(inboundText("x".repeat(9000))).toHaveLength(INBOUND_TEXT_MAX);
  });
});

const NOTIFY = (message: string) => ({
  id: "say",
  kind: "notify",
  name: "Say",
  channel: "thread",
  message,
});

describe("trigger validation", () => {
  it("types a field one trigger lacks as optional, never an error", () => {
    const wf = {
      schemaVersion: 3,
      trigger: {
        id: "by-hand",
        on: {
          type: "manual",
          input: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
        },
      },
      moreTriggers: [
        { id: "daily", on: { type: "schedule", cron: "0 7 * * 1-5", skipHolidays: true } },
      ],
      steps: [NOTIFY("{{trigger.note}} at {{trigger.scheduledAt}}")],
    };
    const ok = validateWorkflow(wf);
    expect(ok.errors).toEqual([]);
    const schema = triggerSchema(Workflow.parse(wf), {});
    expect(schema?.required).toEqual([]);
    const bad = validateWorkflow({ ...wf, steps: [NOTIFY("{{trigger.nope}}")] });
    expect(bad.errors.map((e) => e.code)).toEqual(["template_path"]);
  });

  it("checks every trigger: ids unique, People named, a fixed confirmation, handoff references", () => {
    const wf = {
      schemaVersion: 3,
      trigger: {
        id: "t1",
        on: {
          type: "message",
          channels: ["email", "email"],
          from: {},
          reply: { confirm: "Got {{trigger.channel}}" },
        },
      },
      moreTriggers: [
        { id: "t1", on: { type: "handoff", from: { agent: "intake" } } },
        {
          id: "t3",
          on: {
            type: "webhook",
            hookId: CONTACT,
            dedupeKey: "{{trigger.data.id}}",
            rateLimit: { max: 60, per: "hour" },
          },
        },
      ],
      steps: [NOTIFY("hello")],
      handoff: {
        output: { said: "{{steps.say.output}}", nope: "{{steps.missing.output.x}}" },
        sources: "{{trigger.sources}}",
      },
    };
    const codes = validateWorkflow(wf).errors.map((e) => `${e.stepId}:${e.code}`);
    expect(codes).toEqual(
      expect.arrayContaining([
        "t1:duplicate_id",
        "t1:duplicate_channel",
        "t1:people_empty",
        "t1:reply_not_fixed",
        "t1:template_scope",
      ]),
    );
    expect(codes).not.toContain("t3:template_path");
  });
});

describe("Sloan's handoff", () => {
  const bundle = (channels: string[]) => ({
    workflows: [
      {
        slug: "chat",
        enabled: true,
        workflow: Workflow.parse({
          schemaVersion: 3,
          trigger: {
            id: "t",
            on: { type: "message", channels, from: { clientRoles: ["client_admin"] } },
          },
          steps: [],
        }),
      },
    ],
  });
  it("says whether an agent takes requests from Sloan, and builds the event", () => {
    expect(acceptsSloan(bundle(["sloan"]))).toBe(true);
    expect(acceptsSloan(bundle(["email"]))).toBe(false);
    expect(
      acceptingTriggers(bundle(["sloan"]), "sloan", {
        kind: "user",
        userId: CONTACT,
        role: "client_user",
      }),
    ).toEqual([]);
    const ev = passToAgentEvent({
      agentId: CLIENT,
      threadId: OTHER,
      messageId: CONTACT,
      userId: CONTACT,
    });
    expect(ev).toMatchObject({
      type: "account.request_passed",
      subjectType: "thread",
      subjectId: OTHER,
    });
    expect(() =>
      passToAgentEvent({ agentId: "x", threadId: OTHER, messageId: CONTACT, userId: CONTACT }),
    ).toThrow();
  });
});
