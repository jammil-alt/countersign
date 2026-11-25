// Readers (docs/plan.md §1.86): every server reader of a stored bundle: the connectors a bundle
// needs, promotion's stripping, the account agent's publish guard, forks, copies and the reviewed
// update merge. Against a real database as cs_worker, with the harness's testkit.

import { TESTKIT_QUERY_TOOL, TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import {
  type AgentBundle,
  classifyChange,
  cloneJson,
  evaluateRules,
  processes,
  steps,
  uuidv7,
} from "@countersign/core";
import type { Tx } from "@countersign/db";
import { knownModelIds } from "@countersign/llm";
import { afterAll, describe, expect, it } from "vitest";
import type { AgentsError } from "../errors";
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
  createPromotionDraft,
  createUpdateDraft,
  type PromotionProblem,
  previewPromotion,
  stripForPromotion,
  UNSET_CONTACT_ROLE,
  UNSET_HOOK_ID,
  updateInfo,
} from "./lineage";
import { skillContext } from "./skills";

const harness = await createHarness();
afterAll(() => harness?.close());

/** The harness's bundle, to change in place. */
function bundleOf(edit?: (b: AgentBundle) => void): AgentBundle {
  const b = cloneJson(makeBundle() as AgentBundle);
  edit?.(b);
  return b;
}

function workflowOf(b: AgentBundle): steps.Workflow {
  const w = b.workflows[0]?.workflow;
  if (!w) throw new Error("fixture: no workflow");
  return w;
}

function stepOf(b: AgentBundle, id: string): steps.Step {
  const s = steps.findStep(workflowOf(b).steps, id);
  if (!s) throw new Error(`no step ${id}`);
  return s;
}

/** A Do step: the shape the checks and the scrub read. */
function doStepOf(b: AgentBundle, id: string): steps.DoStep {
  const s = stepOf(b, id);
  if (s.kind !== "do") throw new Error("fixture: expected a Do step");
  return s;
}

/** Puts steps in ahead of the workflow's End. */
function addSteps(b: AgentBundle, ...added: unknown[]) {
  const list = workflowOf(b).steps;
  list.splice(list.length - 1, 0, ...(added as steps.Step[]));
}

const nodeIds = (b: AgentBundle) => [...processes.bundleNodeIds(b)].sort();

describe.skipIf(!harness)("readers of a published version", () => {
  const h = harness as Harness;

  /** Binds a client A agent to A's testkit connection, so it publishes. */
  const bind = (tx: Tx, agentId: string) =>
    updateOperational(tx, { agentId, patch: { bindings: { testkit: h.A.connectionId } } });

  it("asks for the connector of an action its skills don't name", () => {
    // No skills and no extra tools: only the step's action names the testkit.
    const b = bundleOf((x) => {
      x.definition.skills = [];
      workflowOf(x).steps = [
        {
          id: "w",
          name: "Write",
          kind: "do",
          doneBy: "rules",
          uses: { type: "action", action: TESTKIT_UPDATE_TOOL },
          input: {},
        },
      ];
    });
    expect(requiredConnectors(b, {}, h.tools)).toEqual(["testkit"]);
    const read = bundleOf((x) => {
      x.definition.skills = [];
      workflowOf(x).steps = [
        {
          id: "r",
          name: "Read",
          kind: "do",
          doneBy: "rules",
          uses: { type: "action", action: TESTKIT_QUERY_TOOL },
          input: {},
        },
      ];
    });
    expect(requiredConnectors(read, {}, h.tools)).toEqual(["testkit"]);
  });

  it("strips a step's literal record ids for promotion", () => {
    const record = uuidv7();
    const client = bundleOf((x) => {
      doStepOf(x, UPDATE_STEP).input = { id: record, amount: "1.00" };
    });
    const out = stripForPromotion(client, makeBundle(), {});
    // The base step's input is kept where the client's held a record id.
    expect(doStepOf(out, UPDATE_STEP).input).toEqual({ id: "{{trigger.id}}", amount: "1.00" });
    expect(JSON.stringify(out)).not.toContain(record);
  });

  it("refuses the account agent a Do step that pins an automation writing to a client's tool", async () => {
    await h.ops(async (tx) => {
      const made = await createAutomation(tx, {
        tenantId: null,
        definition: {
          schemaVersion: 2,
          slug: "fix-record",
          name: "Fix a record",
          steps: [
            {
              id: "write",
              name: "Write",
              kind: "write",
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
      const bundle = bundleOf((x) => {
        x.definition.kind = "platform";
        x.definition.skills = [];
        workflowOf(x).steps = [
          {
            id: "sub",
            name: "Fix it",
            kind: "do",
            uses: { type: "automation", automation: "fix-record@1" },
            input: {},
          },
          { id: "step-end", kind: "end", name: "Done", outputs: ["done"] },
        ] as steps.Step[];
      });
      const { agent: tpl } = await createTemplate(tx, {
        slug: "supervisor",
        bundle: { ...makeBundle(), definition: bundle.definition },
      });
      const version = await createVersion(tx, { agentId: tpl.id, bundle });
      const errors = await validateForPublish(tx, tpl, version.bundle, h.ctx);
      expect(errors.map((e) => [e.stepId, e.code])).toContainEqual(["sub", "tool_not_allowed"]);
    });
  });

  it("offers a template's new version to its fork as a reviewed update, never applied", async () => {
    const { a, c1, t2 } = await h.ops(async (tx) => {
      const { agent: tpl, version: t1 } = await createTemplate(tx, {
        slug: "update",
        bundle: makeBundle(),
      });
      await publish(tx, { agentId: tpl.id, versionId: t1.id, ctx: h.ctx });
      const { agent: a, version: c1 } = await fork(tx, {
        tenantId: h.A.tenantId,
        slug: "update",
        templateVersionId: t1.id,
      });
      await bind(tx, a.id);
      await publish(tx, { agentId: a.id, versionId: c1.id, ctx: h.ctx });
      const next = bundleOf((x) => {
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
    expect(stepOf(version.bundle, UPDATE_STEP).name).toBe("Update the record");
    expect(version.status).toBe("draft");
    expect(version.authorType).toBe("merge");
    // Invariant 11: the client agent still runs the version it had until the operator publishes.
    expect((await h.ops((tx) => getAgent(tx, a.id))).liveVersionId).toBe(c1.id);
  });

  it("forks, copies and promotes a published version with its ids", async () => {
    const record = uuidv7();
    const { live, forked, copy } = await h.ops(async (tx) => {
      const { agent: tpl } = await createTemplate(tx, { slug: "fork", bundle: makeBundle() });
      const t2 = await createVersion(tx, {
        agentId: tpl.id,
        bundle: bundleOf((x) => {
          stepOf(x, LOOKUP_STEP).name = "Look it up (v2)";
        }),
      });
      const live = await publish(tx, { agentId: tpl.id, versionId: t2.id, ctx: h.ctx });
      const forked = await fork(tx, {
        tenantId: h.A.tenantId,
        slug: "fork",
        templateVersionId: live.id,
      });
      await bind(tx, forked.agent.id);
      const edited = cloneJson(forked.version.bundle);
      doStepOf(edited, UPDATE_STEP).input = { ...doStepOf(edited, UPDATE_STEP).input, id: record };
      stepOf(edited, LOOKUP_STEP).name = "Look it up for A";
      const c2 = await createVersion(tx, { agentId: forked.agent.id, bundle: edited });
      await publish(tx, { agentId: forked.agent.id, versionId: c2.id, ctx: h.ctx });
      const copy = await copyClientAgent(tx, {
        tenantId: h.A.tenantId,
        slug: "fork-copy",
        sourceAgentId: forked.agent.id,
        ctx: h.ctx,
      });
      return { live, forked, copy };
    });
    expect(forked.version.bundleHash).toBe(live.bundleHash);
    expect(forked.version.basedOnTemplateVersionId).toBe(live.id);
    expect(nodeIds(forked.version.bundle)).toContain(UPDATE_STEP);
    // The copy is stripped of the client's record id, as promotion strips it.
    expect(JSON.stringify(copy.version.bundle)).not.toContain(record);
    const preview = await h.ops((tx) =>
      previewPromotion(tx, { agentId: forked.agent.id, ctx: h.ctx }),
    );
    expect(JSON.stringify(preview.stripped)).not.toContain(record);
    expect(preview.result.clean).toBe(true);
    expect(stepOf(preview.result.bundle, LOOKUP_STEP).name).toBe("Look it up for A");
    // The fork needs the testkit bound, from the version's skills and action alike.
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
    const client = bundleOf((x) => {
      x.definition.instructions = `Check records carefully. Questions go to ${email} or ${phone}.`;
      x.definition.permissions.approver = person;
      const lookup = x.definition.skills.find((s) => s.skill === "test.lookup");
      if (!lookup) throw new Error("fixture");
      lookup.parameters = { cutoff: "2026-01-31", owner: email };
      workflowOf(x).triggers.push(
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
      doStepOf(x, UPDATE_STEP).checks = {
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
      addSteps(x, {
        id: "step-ask",
        name: "Ask",
        kind: "do",
        doneBy: "person",
        person: {
          mode: "ask",
          who: contact,
          question: "Is this right?",
          show: {},
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
        },
        input: {},
      });
    });
    const out = stripForPromotion(client, makeBundle(), {});
    const text = JSON.stringify(out);
    for (const literal of [person, contact, hook, email, phone]) {
      expect(text).not.toContain(literal);
    }
    expect(nodeIds(out)).toEqual(nodeIds(client));
    expect(out.definition.permissions.approver).toBeUndefined();
    const w = doStepOf(out, UPDATE_STEP);
    // Unset approvers fall to the default approver; a role stays.
    expect(w.checks?.approval?.approvers).toEqual([{}, { who: "client_admin" }]);
    expect(w.checks?.notify?.[0]?.to).toEqual(["lead"]);
    const ask = doStepOf(out, "step-ask");
    expect(ask.person?.who).toBe("client_admin");
    expect(ask.person?.deadline.tell).toEqual(["operator"]);
    const message = workflowOf(out).triggers.find((t) => t.id === "trg-message")?.on;
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
    expect(processes.validateBundle(client, ctx).errors).toEqual([]);
    expect(processes.validateBundle(out, ctx).errors).toEqual([]);
  });

  // Review of 5.10: the scrub never loosens (invariant 8), never leaves a version that can't be
  // published, and leaves no record id, address or number of the client behind.
  const validate = async (b: AgentBundle) => {
    const { skills } = await h.ops((tx) =>
      skillContext(tx, { tenantId: null, bundle: b, catalog: h.catalog }),
    );
    return processes.validateBundle(b, {
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
    const client = bundleOf((x) => {
      doStepOf(x, UPDATE_STEP).checks = {
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
    const w = doStepOf(out, UPDATE_STEP);
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
    const route = (value: unknown) => ({
      id: "route",
      name: "Route",
      kind: "fork",
      paths: [
        { id: "big", name: "Big vendor", when: rules("{{trigger.name}}", "=", value), steps: [] },
      ],
      otherwise: { id: "rest", steps: [] },
    });
    const hook = (value: unknown) => ({
      id: "trg-hook",
      on: {
        type: "webhook" as const,
        hookId: UNSET_HOOK_ID,
        filter: rules("{{trigger.data.from}}", "=", value),
      },
    });
    const client = bundleOf((x) => {
      addSteps(x, route(id));
      workflowOf(x).triggers.push(hook(email));
    });
    expect(await validate(client)).toEqual([]);
    // No base value: the filter's rule can never match (fewer runs start). A path's rule is never
    // rewritten to stand: it is reported, and promotion and copy refuse it (below).
    const problems: PromotionProblem[] = [];
    const out = stripForPromotion(client, makeBundle(), {}, problems);
    expect(problems).toEqual([
      expect.objectContaining({ stepId: "route", pathId: "big", field: "paths.0.when" }),
    ]);
    expect(problems[0]?.message).toMatch(/"Big vendor".*"Route"/);
    const filter = workflowOf(out).triggers.find((t) => t.id === "trg-hook")?.on;
    expect(filter?.type === "webhook" && filter.filter?.rules).toEqual([
      { field: "{{trigger.data.from}}", op: "in", value: [] },
    ]);
    expect(JSON.stringify(out)).not.toContain(id);
    expect(JSON.stringify(out)).not.toContain(email);
    expect(await validate(out)).toEqual([]);
    // A filter that can match fewer deliveries is not a widening.
    const onlyFilter = bundleOf((x) => {
      workflowOf(x).triggers.push(hook(email));
    });
    expect(
      classifyChange(onlyFilter, stripForPromotion(onlyFilter, makeBundle(), {})).class,
    ).not.toBe("never");
    // The base's own rule, where it has one.
    const base = bundleOf((x) => {
      addSteps(x, route("Acme"));
      workflowOf(x).triggers.push(hook("orders"));
    });
    const none: PromotionProblem[] = [];
    const kept = stripForPromotion(client, base, {}, none);
    const keptPath = stepOf(kept, "route");
    if (keptPath.kind !== "fork") throw new Error("fixture");
    expect(keptPath.paths[0]?.when).toEqual(rules("{{trigger.name}}", "=", "Acme"));
    expect(none).toEqual([]);
  });

  it("stops a repeat whose condition names the client's records after its first pass", async () => {
    const id = uuidv7();
    const again = (value: unknown) => ({
      id: "again",
      name: "Look again",
      kind: "repeat",
      until: { rules: rules("{{trigger.id}}", "=", value) },
      maxTimes: 10,
      onLimit: "proceed",
      steps: [
        {
          id: "again-look",
          name: "Look",
          kind: "do",
          doneBy: "ai",
          uses: { type: "skill", skill: "test.lookup" },
          input: { name: "{{trigger.name}}" },
        },
      ],
    });
    const client = bundleOf((x) => {
      addSteps(x, again(id));
    });
    expect(await validate(client)).toEqual([]);
    const out = stripForPromotion(client, makeBundle(), {});
    const r = stepOf(out, "again");
    if (r.kind !== "repeat") throw new Error("fixture");
    // A field equal to itself holds always: the body runs once.
    expect(r.until).toEqual({ rules: rules("{{trigger.id}}", "=", "{{trigger.id}}") });
    if (!("rules" in r.until)) throw new Error("fixture");
    expect(evaluateRules(r.until.rules, { trigger: { id: "anything" } })).toBe(true);
    expect(JSON.stringify(out)).not.toContain(id);
    expect(await validate(out)).toEqual([]);
    const base = bundleOf((x) => {
      addSteps(x, again("done"));
    });
    const kept = stepOf(stripForPromotion(client, base, {}), "again");
    if (kept.kind !== "repeat") throw new Error("fixture");
    expect(kept.until).toEqual({ rules: rules("{{trigger.id}}", "=", "done") });
  });

  it("refuses to promote or copy a path whose rule names the client's records, naming it", async () => {
    const record = uuidv7();
    const route = (value: unknown) => ({
      id: "risky",
      name: "Risky vendor?",
      kind: "fork",
      paths: [
        {
          id: "risky-yes",
          name: "Risky",
          when: rules("{{trigger.id}}", "in", value),
          steps: [
            {
              id: "risky-ok",
              name: "Sign off",
              kind: "do",
              doneBy: "person",
              person: {
                mode: "approve",
                who: "client_admin",
                question: "OK?",
                show: {},
                channel: "inbox",
                onReject: "stop",
                deadline: { after: "1 day", hours: "clock", ifNoAnswer: "stop" },
              },
              input: {},
            },
          ],
        },
      ],
      otherwise: { id: "risky-no", steps: [] },
    });
    const made = await h.ops(async (tx) => {
      const { agent: tpl } = await createTemplate(tx, { slug: "paths", bundle: makeBundle() });
      const t2 = await createVersion(tx, {
        agentId: tpl.id,
        bundle: bundleOf((x) => {
          stepOf(x, LOOKUP_STEP).name = "Look it up (v2)";
        }),
      });
      const live = await publish(tx, { agentId: tpl.id, versionId: t2.id, ctx: h.ctx });
      const forked = await fork(tx, {
        tenantId: h.A.tenantId,
        slug: "paths",
        templateVersionId: live.id,
      });
      await bind(tx, forked.agent.id);
      const edited = cloneJson(forked.version.bundle);
      addSteps(edited, route([record]));
      const c2 = await createVersion(tx, { agentId: forked.agent.id, bundle: edited });
      await publish(tx, { agentId: forked.agent.id, versionId: c2.id, ctx: h.ctx });
      return { tpl, forked };
    });
    const refusal = (e: unknown) => e as AgentsError;
    const promoted = await h
      .ops((tx) => createPromotionDraft(tx, { agentId: made.forked.agent.id, ctx: h.ctx }))
      .catch(refusal);
    // Refused as a draft that doesn't validate, naming the step and the path.
    const named = {
      code: "invalid_bundle",
      details: [
        expect.objectContaining({
          code: "client_specific_rule",
          stepId: "risky",
          field: "paths.0.when",
        }),
      ],
    };
    expect(promoted).toMatchObject(named);
    expect((promoted as AgentsError).message).toMatch(/"Risky".*"Risky vendor\?"/);
    const copied = await h
      .ops((tx) =>
        copyClientAgent(tx, {
          tenantId: h.B.tenantId,
          slug: "paths-copy",
          sourceAgentId: made.forked.agent.id,
          ctx: h.ctx,
        }),
      )
      .catch(refusal);
    expect(copied).toMatchObject(named);
    // The preview says which path, for the operator to set.
    const preview = await h.ops((tx) =>
      previewPromotion(tx, { agentId: made.forked.agent.id, ctx: h.ctx }),
    );
    expect(preview.problems).toHaveLength(1);
  });

  it("keeps a message trigger that names only contacts valid: the client admin may start it", async () => {
    const contact = uuidv7();
    const client = bundleOf((x) => {
      workflowOf(x).triggers.push({
        id: "trg-m",
        on: { type: "message", channels: ["email"], from: { contactIds: [contact] } },
      });
    });
    expect(await validate(client)).toEqual([]);
    const out = stripForPromotion(client, makeBundle(), {});
    const m = workflowOf(out).triggers.find((t) => t.id === "trg-m")?.on;
    expect(m?.type === "message" && m.from).toEqual({ clientRoles: ["client_admin"] });
    expect(await validate(out)).toEqual([]);
  });

  it("leaves out ids in a reviewer's view and free text, and phone numbers as written", () => {
    const vendor = uuidv7();
    const client = bundleOf((x) => {
      x.definition.instructions = `Vendor ${vendor} is Acme; call Pat at 555-123-4567 or (555) 123-4568.`;
      const w = doStepOf(x, UPDATE_STEP);
      // A part number shaped like a phone number is data, not a number to call.
      w.input = {
        ...w.input,
        sku: "400-100-2000",
        phone: "(555) 123-4569",
        mobile: "+1 555 123 4570",
      };
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
    for (const literal of [vendor, "555-123-4567", "(555) 123-4568"]) {
      expect(text).not.toContain(literal);
    }
    const written = doStepOf(out, UPDATE_STEP);
    expect(written.input.sku).toBe("400-100-2000");
    expect(written.input.phone).toBeUndefined();
    expect(written.input.mobile).toBeUndefined();
    // Step ids and {{refs}} stay.
    expect(text).toContain("{{trigger.id}}");
    expect(nodeIds(out)).toEqual(nodeIds(client));
  });

  it("points a contact with a written-out address at a People role the operator binds", async () => {
    const client = bundleOf((x) => {
      addSteps(x, {
        id: "talk",
        name: "Ask about the invoice",
        kind: "do",
        doneBy: "contact",
        contact: {
          with: "pat@client-a.example",
          channel: "email",
          goal: "Ask when the invoice will be paid.",
          mayShare: [],
          maxTurns: 4,
          messages: { first: "required", later: "required" },
          deadline: { after: "2 days", hours: "clock", ifNoAnswer: "stop" },
        },
        input: {},
      });
    });
    expect(await validate(client)).toEqual([]);
    const out = stripForPromotion(client, makeBundle(), {});
    const talk = doStepOf(out, "talk");
    // A role nobody is bound to: the conversation is refused (nothing is sent) until the operator
    // binds it or names someone.
    expect(talk.contact?.with).toBe(UNSET_CONTACT_ROLE);
    expect(await validate(out)).toEqual([]);
  });
});
