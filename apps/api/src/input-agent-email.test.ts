// Attachments of mail to an agent's own address (`receiveAgentEmail`, which `handleEmail` calls
// for `<agent>.<client>-<id>@domain`). As forwarded mail does (packages/documents/src/forwarding.ts),
// each attachment's bytes are checked against its type and a part that doesn't fit, or that the
// store refuses, is skipped while the rest is kept (PLATFORM_QA INPUT-6).

import { ContentStore, MemoryObjectStore } from "@countersign/connectors";
import { AgentBundle, type AgentBundleInput } from "@countersign/core";
import { agent, contact, document, withTenant } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type ApiHarness, createApiHarness, OPERATOR } from "./api.test-helper";
import { receiveAgentEmail } from "./triggers/inbound-email";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;
const DOMAIN = "in.mezonas.test";

const h = await createApiHarness({ env: { EMAIL_FORWARDING_DOMAIN: DOMAIN } });
afterAll(() => h?.close());

function bundle(): AgentBundle {
  return AgentBundle.parse({
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name: "Ivy", role: "reads invoices", mission: "start when mailed" },
      kind: "functional",
      model: { id: "claude-opus-5-5", maxTokens: 1024 },
      instructions: "Only do what the workflow says.",
      skills: [],
      extraTools: [],
      canCommand: [],
      permissions: { mode: "suggest_only" },
      budgets: { maxSteps: 4, maxCostUsd: "0.10" },
      memory: { enabled: false },
    },
    workflows: [
      {
        slug: "main",
        name: "Main",
        workflow: {
          schemaVersion: 5,
          triggers: [
            { id: "msg", on: { type: "message", channels: ["email"], from: { tags: ["vendor"] } } },
          ],
          outputs: [{ id: "out-done", name: "Done", kind: "nothing" }],
          steps: [{ id: "end", kind: "end", name: "Done", outputs: ["out-done"] }],
        },
      },
    ],
  } as AgentBundleInput);
}

const PDF = "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n";

function mime(input: {
  id: string;
  to: string;
  subject: string;
  parts: { name: string; type: string; body: string }[];
}): Uint8Array {
  const boundary = "b-qa-input";
  const lines = [
    "Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=lumber.example",
    "From: ap@lumber.example",
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    `Message-ID: <${input.id}@lumber.example>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Invoice attached.",
  ];
  for (const p of input.parts) {
    lines.push(
      `--${boundary}`,
      `Content-Type: ${p.type}; name="${p.name}"`,
      `Content-Disposition: attachment; filename="${p.name}"`,
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(p.body).toString("base64"),
    );
  }
  lines.push(`--${boundary}--`, "");
  return new TextEncoder().encode(lines.join("\r\n"));
}

describe.skipIf(!h)("mail to an agent's address: attachments and headers", () => {
  const H = h as ApiHarness;
  let address = "";
  const content = new ContentStore(new MemoryObjectStore());

  beforeAll(async () => {
    for (const level of ["warn", "error", "log"] as const) {
      vi.spyOn(console, level).mockImplementation(() => {});
    }
    await H.t.db.insert(contact).values({
      tenantId: H.A.tenantId,
      name: "Lakeside AP",
      email: "ap@lumber.example",
      roles: ["vendor"],
    });
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/agents`, {
      slug: "ivy",
      bundle: bundle(),
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
    address = j(list.json).address;
    expect(address).toContain(DOMAIN);
  });

  const receive = (raw: Uint8Array) =>
    receiveAgentEmail(
      { db: H.db, content, registry: H.platform.events },
      { from: "ap@lumber.example", to: address, raw, size: raw.length },
      { domain: DOMAIN },
    );

  const documentsNamed = (filename: string) =>
    withTenant(H.db, H.A.tenantId, (tx) =>
      tx
        .select({ id: document.id })
        .from(document)
        .where(and(eq(document.tenantId, H.A.tenantId), eq(document.filename, filename))),
    );

  it("(PLATFORM_QA INPUT-6) an empty attachment beside a real invoice is skipped, not the whole message lost", async () => {
    const raw = mime({
      id: "empty-1",
      to: address,
      subject: "Invoice 1043",
      parts: [
        { name: "inv-1043.pdf", type: "application/pdf", body: PDF },
        { name: "remittance.pdf", type: "application/pdf", body: "" },
      ],
    });
    const out = await receive(raw).catch((e: unknown) => ({
      status: "threw",
      error: String(e),
    }));
    expect(out, JSON.stringify(out)).toMatchObject({ status: "accepted" });
    expect(await documentsNamed("inv-1043.pdf")).toHaveLength(1);
  });

  it("(PLATFORM_QA INPUT-6) an attachment whose bytes aren't its type is skipped, as forwarded mail does", async () => {
    // A web page saved as "invoice.pdf": forwarded mail skips it ("the file is not what its type
    // says"); here it becomes a document and is read as a PDF.
    const raw = mime({
      id: "fake-pdf-1",
      to: address,
      subject: "Invoice 1044",
      parts: [
        { name: "inv-1044.pdf", type: "application/pdf", body: PDF },
        {
          name: "not-really.pdf",
          type: "application/pdf",
          body: "<html><body>Pay now</body></html>",
        },
      ],
    });
    const out = await receive(raw);
    expect(out?.status).toBe("accepted");
    expect(await documentsNamed("not-really.pdf")).toHaveLength(0);
  });
});
