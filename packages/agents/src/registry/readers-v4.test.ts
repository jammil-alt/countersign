// Wave 3b (docs/plan.md §1.86, readers): every server reader of a stored bundle reads a published
// v4 version (processes) as well as a v3 one: the connectors a bundle needs, promotion's
// stripping, the account agent's publish guard, forks, copies and the reviewed update merge. Against
// a real database as cs_worker, with the harness's testkit.

import { TESTKIT_QUERY_TOOL, TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import {
  type AnyAgentBundle,
  classifyChange,
  cloneJson,
  holdsProcess,
  type ProcessAgentBundle,
  processes,
  toProcessBundle,
  uuidv7,
} from "@countersign/core";
import type { Tx } from "@countersign/db";
import { knownModelIds } from "@countersign/llm";
import { afterAll, describe, expect, it } from "vitest";
import {
  createHarness,
  type Harness,
  LOOKUP_STEP,
  makeBundle,
  UPDATE_STEP,
} from "../log/harness.test-helper";
import {
  copyClientAgent,
  createTemplate,
  createVersion,
  fork,
  getAgent,
  publish,
  requiredConnectors,
  updateOperational,
  validateForPublish,
} from "./agents";
import { createAutomation, publishAutomation } from "./automations";
import {
  createUpdateDraft,
  previewPromotion,
  stripForPromotion,
  UNSET_CONTACT_ROLE,
  UNSET_HOOK_ID,
  updateInfo,
} from "./lineage";
import { convertLookup, skillContext } from "./skills";

const harness = await createHarness();
afterAll(() => harness?.close());

/** The harness's bundle read as v4 processes (ids kept), as the builder saves it. */
function v4Bundle(h: Harness, edit?: (b: ProcessAgentBundle) => void): ProcessAgentBundle {
  const b = toProcessBundle(makeBundle(), convertLookup(h.catalog, h.tools));
  edit?.(b);
  return b;
}

function processOf(b: AnyAgentBundle): processes.Process {
  const w = b.workflows[0]?.workflow;
  if (w?.schemaVersion !== 4) throw new Error("fixture: expected a process");
  return w;
}

function stepOf(b: AnyAgentBundle, id: string): processes.Step {
  const s = processes.findStep(processOf(b), id)?.step;
  if (!s) throw new Error(`no step ${id}`);
  return s;
}

describe.skipIf(!harness)("readers of a published v4 version", () => {
  const h = harness as Harness;

  /** Binds a client A agent to A's testkit connection, so it publishes. */
  const bind = (tx: Tx, agentId: string) =>
    updateOperational(tx, { agentId, patch: { bindings: { testkit: h.A.connectionId } } });

  it("asks for the connector of a v4 read or write tool its skills don't name", () => {
    // No skills and no extra tools: only the process's write names the testkit.
    const b = v4Bundle(h, (x) => {
      x.definition.skills = [];
      processOf(x).steps = [
        { id: "w", name: "Write", kind: "write", tool: TESTKIT_UPDATE_TOOL, input: {} },
      ];
    });
    expect(requiredConnectors(b, {}, h.tools)).toEqual(["testkit"]);
    const read = v4Bundle(h, (x) => {
      x.definition.skills = [];
      processOf(x).steps = [
        { id: "r", name: "Read", kind: "read", tool: TESTKIT_QUERY_TOOL, input: {} },
      ];
    });
    expect(requiredConnectors(read, {}, h.tools)).toEqual(["testkit"]);
  });

  it("strips a v4 skill step's customized settings and literal record ids for promotion", () => {
    const record = uuidv7();
    const client = v4Bundle(h, (x) => {
      const s = stepOf(x, LOOKUP_STEP);
      if (s.kind !== "skill") throw new Error("fixture");
      s.customize = { settings: { vendor: record, tone: "plain" } };
      const w = stepOf(x, UPDATE_STEP);
      if (w.kind !== "write") throw new Error("fixture");
      w.input = { id: record, amount: "1.00" };
    });
    const out = stripForPromotion(client, makeBundle(), {});
    const s = stepOf(out, LOOKUP_STEP);
    const w = stepOf(out, UPDATE_STEP);
    if (s.kind !== "skill" || w.kind !== "write") throw new Error("fixture");
    expect(s.customize?.settings).toEqual({ tone: "plain" });
    // The base (v3) step's input is kept where the client's held a record id.
    expect(w.input).toEqual({ id: "{{trigger.id}}", amount: "1.00" });
    expect(JSON.stringify(out)).not.toContain(record);
  });

  it("refuses the account agent a v4 process step that pins an automation writing to a client's tool", async () => {
    await h.ops(async (tx) => {
      const made = await createAutomation(tx, {
        tenantId: null,
        definition: {
          schemaVersion: 1,
          slug: "fix-record",
          name: "Fix a record",
          steps: [
            {
              id: "write",
              name: "Write",
              kind: "action",
              tool: TESTKIT_UPDATE_TOOL,
              input: { id: "r1", amount: "1.00" },
            },
          ],
        },
        ctx: h.ctx,
      });
      await publishAutomation(tx, {
        automationId: made.automation.id,
        versionId: made.version.id,
        ctx: h.ctx,
      });
      const bundle = v4Bundle(h, (x) => {
        x.definition.kind = "platform";
        x.definition.skills = [];
        processOf(x).steps = [
          { id: "sub", name: "Fix it", kind: "process", process: "fix-record@1", input: {} },
        ];
      });
      const { agent: tpl } = await createTemplate(tx, {
        slug: "supervisor",
        bundle: { ...makeBundle(), definition: bundle.definition },
      });
      const version = await createVersion(tx, { agentId: tpl.id, bundle });
      const errors = await validateForPublish(tx, tpl, version.bundle, h.ctx);
      expect(errors.map((e) => [e.stepId, e.field, e.code])).toContainEqual([
        "sub",
        "process",
        "tool_not_allowed",
      ]);
    });
  });

  it("offers a template's v4 version to its v3 fork as a reviewed update, never applied", async () => {
    const { a, c1, t2 } = await h.ops(async (tx) => {
      const { agent: tpl, version: t1 } = await createTemplate(tx, {
        slug: "v4-update",
        bundle: makeBundle(),
      });
      await publish(tx, { agentId: tpl.id, versionId: t1.id, ctx: h.ctx });
      const { agent: a, version: c1 } = await fork(tx, {
        tenantId: h.A.tenantId,
        slug: "v4-update",
        templateVersionId: t1.id,
      });
      await bind(tx, a.id);
      await publish(tx, { agentId: a.id, versionId: c1.id, ctx: h.ctx });
      const next = v4Bundle(h, (x) => {
        stepOf(x, UPDATE_STEP).name = "Update the record";
      });
      const v2 = await createVersion(tx, { agentId: tpl.id, bundle: next });
      const t2 = await publish(tx, { agentId: tpl.id, versionId: v2.id, ctx: h.ctx });
      return { a, c1, t2 };
    });
    const info = await h.ops((tx) => updateInfo(tx, { agentId: a.id }));
    expect(info.available).toBe(true);
    expect(info.templateLive?.id).toBe(t2.id);
    const { version } = await h.ops((tx) =>
      createUpdateDraft(tx, { agentId: a.id, actorId: h.operatorId, ctx: h.ctx }),
    );
    expect(holdsProcess(version.bundle)).toBe(true);
    expect(stepOf(version.bundle, UPDATE_STEP).name).toBe("Update the record");
    expect(version.status).toBe("draft");
    expect(version.authorType).toBe("merge");
    // Invariant 11: the client agent still runs the version it had until the operator publishes.
    expect((await h.ops((tx) => getAgent(tx, a.id))).liveVersionId).toBe(c1.id);
  });

  it("forks, copies and promotes a published v4 version with its ids", async () => {
    const record = uuidv7();
    const { live, forked, copy } = await h.ops(async (tx) => {
      // A template's v1 (v3) and its v2 of v4 processes, published: what the builder saves.
      const { agent: tpl } = await createTemplate(tx, { slug: "v4-fork", bundle: makeBundle() });
      const t2 = await createVersion(tx, { agentId: tpl.id, bundle: v4Bundle(h) });
      const live = await publish(tx, { agentId: tpl.id, versionId: t2.id, ctx: h.ctx });
      const forked = await fork(tx, {
        tenantId: h.A.tenantId,
        slug: "v4-fork",
        templateVersionId: live.id,
      });
      await bind(tx, forked.agent.id);
      const edited = cloneJson(forked.version.bundle);
      const w = stepOf(edited, UPDATE_STEP);
      if (w.kind !== "write") throw new Error("fixture");
      w.input = { ...w.input, id: record };
      stepOf(edited, LOOKUP_STEP).name = "Look it up for A";
      const c2 = await createVersion(tx, { agentId: forked.agent.id, bundle: edited });
      await publish(tx, { agentId: forked.agent.id, versionId: c2.id, ctx: h.ctx });
      const copy = await copyClientAgent(tx, {
        tenantId: h.A.tenantId,
        slug: "v4-fork-copy",
        sourceAgentId: forked.agent.id,
        ctx: h.ctx,
      });
      return { live, forked, copy };
    });
    expect(forked.version.bundleHash).toBe(live.bundleHash);
    expect(forked.version.basedOnTemplateVersionId).toBe(live.id);
    expect(processes.nodeIds(processOf(forked.version.bundle))).toContain(UPDATE_STEP);
    // The copy is stripped of the client's record id, as promotion strips it.
    expect(JSON.stringify(copy.version.bundle)).not.toContain(record);
    expect(holdsProcess(copy.version.bundle)).toBe(true);
    const preview = await h.ops((tx) =>
      previewPromotion(tx, { agentId: forked.agent.id, ctx: h.ctx }),
    );
    expect(JSON.stringify(preview.stripped)).not.toContain(record);
    expect(preview.result.clean).toBe(true);
    expect(stepOf(preview.result.bundle, LOOKUP_STEP).name).toBe("Look it up for A");
    // The fork needs the testkit bound, from the v4 version's skills and write alike.
    const { skills } = await h.ops((tx) =>
      skillContext(tx, {
        tenantId: h.A.tenantId,
        bundle: forked.version.bundle,
        catalog: h.catalog,
      }),
    );
    expect(requiredConnectors(forked.version.bundle, skills, h.tools)).toEqual(["testkit"]);
  });

  // Invariant 11: a promotion or a copy never carries the source client's people, contacts,
  // connections or literal addresses; each is reset to the template's value or left unset, step
  // ids stay as they were, and the result still validates.
  it("leaves out the client's people, contacts, hooks and addresses, and still validates", async () => {
    const person = uuidv7();
    const contact = uuidv7();
    const hook = uuidv7();
    const email = "pat@client-a.example";
    const phone = "+15551230000";
    const client = v4Bundle(h, (x) => {
      x.definition.instructions = `Check records carefully. Questions go to ${email} or ${phone}.`;
      x.definition.permissions.approver = person;
      const lookup = x.definition.skills.find((s) => s.skill === "test.lookup");
      if (!lookup) throw new Error("fixture");
      lookup.parameters = { cutoff: "2026-01-31", owner: email };
      const p = processOf(x);
      p.triggers.push(
        { id: "trg-hook", on: { type: "webhook", hookId: hook } },
        {
          id: "trg-message",
          on: {
            type: "message",
            channels: ["email"],
            from: { contactIds: [contact], clientRoles: ["client_admin"] },
          },
        },
      );
      const w = stepOf(x, UPDATE_STEP);
      if (w.kind !== "write") throw new Error("fixture");
      w.checks = {
        approval: {
          required: "required",
          mode: "in_turn",
          approvers: [{ who: person }, { who: "client_admin" }],
          ifNoAnswer: "stop",
          onReject: "stop",
        },
        notify: [
          {
            to: [person, "lead"],
            channel: "inbox",
            message: `Updated. Copy ${email}.`,
          },
        ],
      };
      p.steps.push({
        id: "step-ask",
        name: "Ask",
        kind: "person",
        mode: "ask",
        assignee: contact,
        title: "Is this right?",
        payload: {},
        channel: "inbox",
        onReject: "stop",
        deadline: {
          after: "2 days",
          hours: "clock",
          tell: [person, "operator"],
          ifNoAnswer: {
            escalate: {
              to: person,
              deadline: { after: "1 day", hours: "clock", ifNoAnswer: "stop" },
            },
          },
        },
      });
    });
    const ids = (b: AnyAgentBundle) => processes.nodeIds(processOf(b));
    const out = stripForPromotion(client, makeBundle(), {});
    const text = JSON.stringify(out);
    for (const literal of [person, contact, hook, email, phone]) {
      expect(text).not.toContain(literal);
    }
    expect(ids(out)).toEqual(ids(client));
    expect(out.definition.permissions.approver).toBeUndefined();
    const w = stepOf(out, UPDATE_STEP);
    if (w.kind !== "write") throw new Error("fixture");
    // Unset approvers fall to the default approver; a role stays.
    expect(w.checks?.approval?.approvers).toEqual([{}, { who: "client_admin" }]);
    expect(w.checks?.notify?.[0]?.to).toEqual(["lead"]);
    const ask = stepOf(out, "step-ask");
    if (ask.kind !== "person") throw new Error("fixture");
    expect(ask.assignee).toBe("client_admin");
    expect(ask.deadline.tell).toEqual(["operator"]);
    const triggers = processOf(out).triggers;
    const message = triggers.find((t) => t.id === "trg-message")?.on;
    expect(message?.type === "message" && message.from).toEqual({ clientRoles: ["client_admin"] });
    const lookup = out.definition.skills.find((s) => s.skill === "test.lookup");
    expect(lookup?.parameters).toBeUndefined();

    const { skills } = await h.ops((tx) =>
      skillContext(tx, { tenantId: null, bundle: out, catalog: h.catalog }),
    );
    // The lookup skill as a version that declares the two parameters the client set.
    for (const [ref, def] of Object.entries(skills)) {
      if (def.id !== "test.lookup") continue;
      skills[ref] = {
        ...def,
        parameters: [
          { name: "cutoff", label: "Cut-off", type: "date", default: "2026-01-01" },
          { name: "owner", label: "Owner", type: "text", default: "" },
        ],
      };
    }
    const ctx = { skills, tools: h.tools.specs(), models: knownModelIds() };
    expect(processes.validateAnyBundle(client, ctx).errors).toEqual([]);
    expect(processes.validateAnyBundle(out, ctx).errors).toEqual([]);
  });

  // Review of 5.10: the scrub never loosens (invariant 8), never leaves a version that can't be
  // published, and leaves no record id, address or number of the client behind.
  const validate = async (b: AnyAgentBundle) => {
    const { skills } = await h.ops((tx) =>
      skillContext(tx, { tenantId: null, bundle: b, catalog: h.catalog }),
    );
    return processes.validateAnyBundle(b, {
      skills,
      tools: h.tools.specs(),
      models: knownModelIds(),
    }).errors;
  };
  const rules = (field: string, op: string, value: unknown) => ({
    match: "all" as const,
    rules: [{ field, op: op as "=", value }],
  });

  it("drops a check's condition that names the client's records, so the check always applies", async () => {
    const [a, b] = [uuidv7(), uuidv7()];
    const client = v4Bundle(h, (x) => {
      const w = stepOf(x, UPDATE_STEP);
      if (w.kind !== "write") throw new Error("fixture");
      w.checks = {
        approval: {
          required: "required",
          mode: "in_turn",
          ifNoAnswer: "stop",
          onReject: "stop",
          when: rules("{{trigger.id}}", "in", [a, b]),
        },
        confer: {
          when: rules("{{trigger.id}}", "=", a),
          with: [{ ai: { focus: "the amount" } }],
        },
        notify: [
          {
            to: ["lead"],
            channel: "inbox",
            message: "Updated.",
            when: rules("{{trigger.id}}", "=", b),
          },
        ],
      };
    });
    expect(await validate(client)).toEqual([]);
    const out = stripForPromotion(client, makeBundle(), {});
    const w = stepOf(out, UPDATE_STEP);
    if (w.kind !== "write") throw new Error("fixture");
    expect(w.checks?.approval).toEqual({
      required: "required",
      mode: "in_turn",
      ifNoAnswer: "stop",
      onReject: "stop",
    });
    expect(w.checks?.confer?.when).toBeUndefined();
    expect(w.checks?.notify?.[0]?.when).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain(a);
    expect(JSON.stringify(out)).not.toContain(b);
    expect(await validate(out)).toEqual([]);
    // No scrub loosens: the change from the client's version is not one an owner may not draft.
    expect(classifyChange(client, out).class).not.toBe("never");
  });

  it("narrows a trigger's filter and a path's rule that name the client's records", async () => {
    const id = uuidv7();
    const email = "pat@client-a.example";
    const route = (value: unknown): processes.Step =>
      ({
        id: "route",
        name: "Route",
        kind: "if",
        paths: [
          { id: "big", name: "Big vendor", when: rules("{{trigger.name}}", "=", value), steps: [] },
        ],
        otherwise: { id: "rest", steps: [] },
      }) as processes.Step;
    const hook = (value: unknown) => ({
      id: "trg-hook",
      on: {
        type: "webhook" as const,
        hookId: UNSET_HOOK_ID,
        filter: rules("{{trigger.data.from}}", "=", value),
      },
    });
    const client = v4Bundle(h, (x) => {
      processOf(x).steps.push(route(id));
      processOf(x).triggers.push(hook(email));
    });
    expect(await validate(client)).toEqual([]);
    // No base value: the rule can never match (fewer runs start, the path is never taken).
    const out = stripForPromotion(client, makeBundle(), {});
    const never = { field: "{{trigger.name}}", op: "in", value: [] };
    const path = stepOf(out, "route");
    if (path.kind !== "if") throw new Error("fixture");
    expect(path.paths[0]?.when.rules).toEqual([never]);
    const filter = processOf(out).triggers.find((t) => t.id === "trg-hook")?.on;
    expect(filter?.type === "webhook" && filter.filter?.rules).toEqual([
      { field: "{{trigger.data.from}}", op: "in", value: [] },
    ]);
    expect(JSON.stringify(out)).not.toContain(id);
    expect(JSON.stringify(out)).not.toContain(email);
    expect(await validate(out)).toEqual([]);
    // A filter that can match fewer deliveries is not a widening.
    const onlyFilter = v4Bundle(h, (x) => {
      processOf(x).triggers.push(hook(email));
    });
    expect(
      classifyChange(onlyFilter, stripForPromotion(onlyFilter, makeBundle(), {})).class,
    ).not.toBe("never");
    // The base's own rule, where it has one.
    const base = v4Bundle(h, (x) => {
      processOf(x).steps.push(route("Acme"));
      processOf(x).triggers.push(hook("orders"));
    });
    const kept = stripForPromotion(client, base, {});
    const keptPath = stepOf(kept, "route");
    if (keptPath.kind !== "if") throw new Error("fixture");
    expect(keptPath.paths[0]?.when).toEqual(rules("{{trigger.name}}", "=", "Acme"));
  });

  it("keeps a message trigger that names only contacts valid: the client admin may start it", async () => {
    const contact = uuidv7();
    const client = v4Bundle(h, (x) => {
      processOf(x).triggers.push({
        id: "trg-m",
        on: { type: "message", channels: ["email"], from: { contactIds: [contact] } },
      });
    });
    expect(await validate(client)).toEqual([]);
    const out = stripForPromotion(client, makeBundle(), {});
    const m = processOf(out).triggers.find((t) => t.id === "trg-m")?.on;
    expect(m?.type === "message" && m.from).toEqual({ clientRoles: ["client_admin"] });
    expect(await validate(out)).toEqual([]);
  });

  it("leaves out ids in rule rows, a reviewer's view and free text, and phone numbers as written", () => {
    const vendor = uuidv7();
    const account = uuidv7();
    const client = v4Bundle(h, (x) => {
      x.definition.instructions = `Vendor ${vendor} is Acme; call Pat at 555-123-4567 or (555) 123-4568.`;
      const s = stepOf(x, LOOKUP_STEP) as processes.Step & Record<string, unknown>;
      s.customize = {
        addInstructions: `Pat (pat@acme.example) approves vendor ${vendor}.`,
        rules: {
          add: [
            {
              id: "r1",
              when: rules("{{input.vendorId}}", "=", vendor),
              set: { account },
            },
          ],
        },
      } as never;
      const w = stepOf(x, UPDATE_STEP);
      if (w.kind !== "write") throw new Error("fixture");
      w.checks = {
        confer: {
          with: [
            {
              person: "client_admin",
              show: { vendor, amount: "{{trigger.id}}" },
              deadline: { after: "1 day", hours: "clock", ifNoAnswer: "stop" },
            },
          ],
        },
      };
    });
    const out = stripForPromotion(client, makeBundle(), {});
    const text = JSON.stringify(out);
    for (const literal of [vendor, account, "555-123-4567", "(555) 123-4568", "pat@acme.example"]) {
      expect(text).not.toContain(literal);
    }
    // Step ids and {{refs}} stay.
    expect(text).toContain("{{trigger.id}}");
    expect(processes.nodeIds(processOf(out))).toEqual(processes.nodeIds(processOf(client)));
  });

  it("points a conversation with a written-out contact at a People role the operator binds", async () => {
    const client = v4Bundle(h, (x) => {
      processOf(x).steps.push({
        id: "talk",
        name: "Ask about the invoice",
        kind: "conversation",
        with: "pat@client-a.example",
        channel: "email",
        goal: "Ask when the invoice will be paid.",
        mayShare: [],
        find: {},
        maxTurns: 4,
        messages: { first: "required", later: "required" },
        deadline: { after: "2 days", hours: "clock", ifNoAnswer: "stop" },
      });
    });
    expect(await validate(client)).toEqual([]);
    const out = stripForPromotion(client, makeBundle(), {});
    const talk = stepOf(out, "talk");
    if (talk.kind !== "conversation") throw new Error("fixture");
    // A role nobody is bound to: the conversation is refused, never sent, until the operator
    // binds it or names someone.
    expect(talk.with).toBe(UNSET_CONTACT_ROLE);
    expect(await validate(out)).toEqual([]);
  });
});
