// P-9 (docs/plan.md §1.71): `docs.read` answers a document's reading, reading it first when there
// is none yet (a reply's PDF the background hasn't read), as a quote unless asked otherwise; and
// `comms.read-message` is a tool-mode skill over `inbound.get`.

import { describe, expect, it } from "vitest";
import { docsRead } from "./docs";
import { INBOUND_SKILLS, inboundGet } from "./inbound";
import type { DocumentForTool, DocumentsPort, ToolInvocation } from "./types";

const DOC = "0190a1b2-0000-7000-8000-0000000000d1";

function doc(read: boolean): DocumentForTool {
  return {
    id: DOC,
    source: "email",
    filename: "quote-1042.pdf",
    mimeType: "application/pdf",
    status: read ? "extracted" : "received",
    pageCount: 1,
    transactionId: null,
    receivedAt: "2026-11-08T15:00:00.000Z",
    url: null,
    extraction: read
      ? {
          id: "0190a1b2-0000-7000-8000-0000000000e1",
          model: "m",
          header: { vendorName: "Keystone" },
          subtotal: "580.0000",
          freight: "0.0000",
          surcharges: [],
          tax: "0.0000",
          total: "580.0000",
          totalsMatch: true,
          problems: [],
          lines: [],
        }
      : null,
  };
}

function port(read: boolean) {
  const calls: unknown[] = [];
  let done = read;
  const p = {
    async get() {
      return doc(done);
    },
    async extract(_tenantId: string, input: unknown) {
      calls.push(input);
      done = true;
      return {} as never;
    },
  } as unknown as DocumentsPort;
  return { p, calls };
}

const ctx = (documents: DocumentsPort) =>
  ({
    tenantId: "t",
    agentId: "a",
    agentVersionId: "av",
    runId: "r",
    stepRunId: "s",
    stepId: "read",
    mode: "live",
    documents,
  }) as unknown as ToolInvocation;

describe("docs.read", () => {
  it("reads a document nobody has read yet, as a quote, then answers that reading", async () => {
    const { p, calls } = port(false);
    const out = (await docsRead.run(docsRead.input.parse({ documentId: DOC }), ctx(p))) as {
      readNow: boolean;
    };
    expect(out.readNow).toBe(true);
    expect(calls).toEqual([expect.objectContaining({ documentId: DOC, reading: "quote" })]);
    expect(docsRead.output.parse(out)).toMatchObject({
      sources: [DOC, "0190a1b2-0000-7000-8000-0000000000e1"],
    });
  });

  it("answers the reading there is, without reading again", async () => {
    const { p, calls } = port(true);
    const out = (await docsRead.run({ documentId: DOC, as: "invoice" }, ctx(p))) as {
      readNow: boolean;
    };
    expect(out.readNow).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("comms.read-message", () => {
  it("is a tool-mode skill over inbound.get, with its input and output", () => {
    const [skill] = INBOUND_SKILLS;
    expect(skill).toMatchObject({ id: "comms.read-message", mode: "tool", handler: "inbound.get" });
    expect(skill?.output).toEqual(inboundGet.spec.output);
  });
});
