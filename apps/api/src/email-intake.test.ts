// Email intake (owner, 2026-11-28): an agent takes mail at its own address from the people its
// triggers name (the default), only from one domain, only from a list, or from anyone. Only from a
// domain or a list wants the sender proven (SPF or DMARC); open takes anyone, and says so.

import { ContentStore, MemoryObjectStore } from "@countersign/connectors";
import { AgentBundle, type AgentBundleInput, type EmailIntake } from "@countersign/core";
import { agent, contact, rawRecord, withTenant } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type ApiHarness, createApiHarness, OPERATOR } from "./api.test-helper";
import { receiveAgentEmail } from "./triggers/inbound-email";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;
const DOMAIN = "in.mezonas.test";

const h = await createApiHarness({ env: { EMAIL_FORWARDING_DOMAIN: DOMAIN } });
afterAll(() => h?.close());

function bundle(name: string, emailIntake?: EmailIntake): AgentBundle {
  return AgentBundle.parse({
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name, role: "reviews invoices", mission: "start when mailed" },
      kind: "functional",
      model: { id: "claude-opus-5-5", maxTokens: 1024 },
      instructions: "Only do what the workflow says.",
      skills: [],
      extraTools: [],
      canCommand: [],
      permissions: { mode: "suggest_only" },
      budgets: { maxSteps: 4, maxCostUsd: "0.10" },
      memory: { enabled: false },
      ...(emailIntake ? { emailIntake } : {}),
    },
    workflows: [
      {
        slug: "main",
        name: "Main",
        workflow: {
          schemaVersion: 5,
          triggers: [
            {
              id: "msg",
              on: { type: "message", channels: ["email"], from: { relationships: ["vendor"] } },
            },
          ],
          outputs: [{ id: "out-done", name: "Done", kind: "nothing" }],
          steps: [{ id: "end", kind: "end", name: "Done", outputs: ["out-done"] }],
        },
      },
    ],
  } as AgentBundleInput);
}

let n = 0;
function mail(to: string, from: string, proven: boolean): Uint8Array {
  const domain = from.slice(from.indexOf("@") + 1);
  const lines = [
    proven
      ? `Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=${domain}`
      : `Authentication-Results: mx.cloudflare.net; dmarc=none header.from=${domain}`,
    `From: ${from}`,
    `To: ${to}`,
    "Subject: Invoice NF-45102",
    `Message-ID: <intake-${n++}@${domain}>`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Invoice attached.",
  ];
  return new TextEncoder().encode(lines.join("\r\n"));
}

describe.skipIf(!h)("an agent's email intake", () => {
  const H = h as ApiHarness;
  const content = new ContentStore(new MemoryObjectStore());
  const address: Record<string, string> = {};

  async function agentWith(slug: string, intake?: EmailIntake) {
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/agents`, {
      slug,
      bundle: bundle(slug.charAt(0).toUpperCase() + slug.slice(1), intake),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const id = j(created.json).agent.id as string;
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${id}/versions/${j(created.json).version.id}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, id));
    const list = await H.call(OPERATOR, "GET", `/api/ops/agents/${id}/triggers`);
    address[slug] = j(list.json).address;
    expect(address[slug]).toContain(DOMAIN);
  }

  beforeAll(async () => {
    for (const level of ["warn", "error", "log"] as const) {
      vi.spyOn(console, level).mockImplementation(() => {});
    }
    // A known vendor, proven, on another domain than the client's.
    await H.t.db.insert(contact).values({
      tenantId: H.A.tenantId,
      name: "Northfork AP",
      email: "ap@northfork.example",
      relationship: "vendor",
    });
    await agentWith("peggy");
    await agentWith("dora", { mode: "domain", domain: "client.example" });
    await agentWith("lisa", {
      mode: "list",
      senders: ["billing@supplier.example", "trusted.example"],
    });
    await agentWith("owen", { mode: "open" });
  });

  const receive = (slug: string, from: string, proven = true) => {
    const raw = mail(address[slug] as string, from, proven);
    return receiveAgentEmail(
      { db: H.db, content, registry: H.platform.events },
      { from, to: address[slug] as string, raw, size: raw.length },
      { domain: DOMAIN },
    );
  };

  it("by default takes the people its triggers name, and no stranger", async () => {
    expect(await receive("peggy", "ap@northfork.example")).toMatchObject({ status: "accepted" });
    expect(await receive("peggy", "new@unknown-vendor.example")).toMatchObject({
      status: "refused",
      reason: "sender_not_allowed",
    });
  });

  it("only from a domain: proven mail from it or a subdomain, and no one else, known or not", async () => {
    expect(await receive("dora", "ap@client.example")).toMatchObject({ status: "accepted" });
    expect(await receive("dora", "ap@mail.client.example")).toMatchObject({ status: "accepted" });
    // Not proven: anyone can write that From.
    expect(await receive("dora", "ap@client.example", false)).toMatchObject({ status: "refused" });
    // A known vendor outside the domain: "only" means only.
    expect(await receive("dora", "ap@northfork.example")).toMatchObject({ status: "refused" });
  });

  it("only from a list: a listed address or domain, proven", async () => {
    expect(await receive("lisa", "billing@supplier.example")).toMatchObject({ status: "accepted" });
    expect(await receive("lisa", "sales@supplier.example")).toMatchObject({ status: "refused" });
    expect(await receive("lisa", "anyone@trusted.example")).toMatchObject({ status: "accepted" });
    expect(await receive("lisa", "anyone@trusted.example", false)).toMatchObject({
      status: "refused",
    });
  });

  it("open: anyone, proven or not, and the message says it got in by the open intake", async () => {
    const out = await receive("owen", "invoices@never-seen.example", false);
    expect(out).toMatchObject({ status: "accepted" });
    const id = (out as { rawRecordId: string }).rawRecordId;
    const [row] = await withTenant(H.db, H.A.tenantId, (tx) =>
      tx
        .select({ payload: rawRecord.payload })
        .from(rawRecord)
        .where(and(eq(rawRecord.id, id), eq(rawRecord.tenantId, H.A.tenantId))),
    );
    // Nobody the client knows: no contact, and the words stay data for `inbound.get`.
    expect(row?.payload).toMatchObject({ contactId: null, from: "invoices@never-seen.example" });
  });
});
