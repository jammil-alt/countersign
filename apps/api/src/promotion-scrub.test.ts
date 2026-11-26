// Review of audit 5.10: the promotion and copy scrub (`stripForPromotion`) keeps every template
// the platform ships valid. Each seeded platform template and each pack template, as it ships and
// as a client's version of it naming the client's people and contacts, is scrubbed and validated
// as a promotion's draft is: the scrub adds no validation error and leaves no id it was given.

import { parseVersionBundle, skillContext, stripForPromotion } from "@countersign/agents";
import { type AgentBundle, cloneJson, isPlainObject, processes, uuidv7 } from "@countersign/core";
import { seedVersionBundle, withOperator } from "@countersign/db";
import billClerk from "@countersign/db/seed/agents/bill-clerk.v1.json";
import builder from "@countersign/db/seed/agents/builder.v1.json";
import coordinator from "@countersign/db/seed/agents/coordinator.v1.json";
import documentClerk from "@countersign/db/seed/agents/document-clerk.v1.json";
import supervisor from "@countersign/db/seed/agents/supervisor.v1.json";
import { knownModelIds } from "@countersign/llm";
import { afterAll, describe, expect, it } from "vitest";
import { type ApiHarness, createApiHarness } from "./api.test-helper";

// Step model: one seeded version per platform agent, its v1.
const SEEDED: Record<string, Record<number, unknown>> = {
  "bill-clerk": { 1: billClerk },
  builder: { 1: builder },
  coordinator: { 1: coordinator },
  "document-clerk": { 1: documentClerk },
  supervisor: { 1: supervisor },
};

/**
 * A client's version of a template: every person it names is one of the client's (a user or
 * contact id), and every message trigger lists only the client's contacts.
 */
function personalized(bundle: AgentBundle, ids: string[]): AgentBundle {
  const out = cloneJson(bundle);
  const id = () => {
    const v = uuidv7();
    ids.push(v);
    return v;
  };
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const v of node) walk(v);
      return;
    }
    if (!isPlainObject(node)) return;
    for (const key of Object.keys(node)) {
      const v = node[key];
      if ((key === "assignee" || key === "who" || key === "approver") && typeof v === "string") {
        node[key] = id();
      } else if ((key === "to" || key === "tell") && Array.isArray(v)) {
        node[key] = [id()];
      } else if (key === "from" && isPlainObject(v) && node.type === "message") {
        node[key] = { contactIds: [id()] };
      } else walk(v);
    }
  };
  walk(out.workflows);
  // And a message trigger that lists only one of the client's contacts.
  for (const [i, w] of out.workflows.entries()) {
    if (w.workflow.triggers.length >= 10) continue;
    w.workflow.triggers.push({
      id: `trg-client-message-${i}`,
      on: { type: "message", channels: ["email"], from: { contactIds: [id()] } },
    });
  }
  if (out.definition.permissions.approver !== undefined) out.definition.permissions.approver = id();
  return out;
}

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("the promotion scrub on every shipped template", () => {
  const H = h as ApiHarness;
  const ctx = H?.platform.ctx;

  const errorsOf = async (bundle: AgentBundle) => {
    const { skills } = await withOperator(H.db, [], (tx) =>
      skillContext(tx, { tenantId: null, bundle, catalog: ctx.catalog }),
    );
    const r = processes.validateBundle(bundle, {
      skills,
      tools: ctx.tools.specs(),
      models: knownModelIds(),
      ...(ctx.events ? { events: ctx.events } : {}),
    });
    return r.errors.map((e) => `${e.code} ${e.field ?? ""}`).sort();
  };

  const templates = (): [string, AgentBundle][] => {
    const out: [string, AgentBundle][] = [];
    for (const [slug, files] of Object.entries(SEEDED)) {
      const latest = Math.max(...Object.keys(files).map(Number));
      out.push([
        `${slug} v${latest}`,
        parseVersionBundle(seedVersionBundle(files, latest, slug)) as AgentBundle,
      ]);
    }
    for (const pack of H.platform.packs) {
      for (const t of pack.manifest.templates) {
        out.push([
          `${pack.manifest.id}/${t.slug}`,
          (t.versions?.at(-1) ?? t.bundle) as AgentBundle,
        ]);
      }
    }
    return out;
  };

  it("scrubs each template, as shipped and as a client's version, into one that validates", async () => {
    const list = templates();
    expect(list).toHaveLength(
      Object.keys(SEEDED).length +
        H.platform.packs.reduce((n, pack) => n + pack.manifest.templates.length, 0),
    );
    for (const [name, template] of list) {
      const shipped = await errorsOf(template);
      // As it ships, with no template behind it.
      expect(await errorsOf(stripForPromotion(template, null, {})), name).toEqual(shipped);
      // A client's version, promoted into it, and copied into another client without one.
      const ids: string[] = [];
      const client = personalized(template, ids);
      for (const base of [template, null]) {
        const out = stripForPromotion(client, base, {});
        expect(await errorsOf(out), `${name} (client's, base ${base ? "kept" : "none"})`).toEqual(
          shipped,
        );
        const text = JSON.stringify(out);
        for (const v of ids) expect(text, name).not.toContain(v);
      }
    }
  });
});
