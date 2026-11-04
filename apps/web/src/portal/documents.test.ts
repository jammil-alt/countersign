import { describe, expect, it } from "vitest";
import { isApiError } from "../api/client";
import { uploadFiles } from "../api/upload";
import { documentStatus, figure, money } from "./documents";

describe("document figures", () => {
  it("formats money from decimal strings with separators, never floats", () => {
    expect(money("9742.3500")).toBe("$9,742.35");
    expect(money("0.1")).toBe("$0.10");
    expect(money("-120.0000")).toBe("-$120.00");
    // The largest numeric(14,4), straight from its string.
    expect(money("9999999999.9949")).toBe("$9,999,999,999.99");
    expect(money(null)).toBe("–");
  });

  it("shows quantities and unit prices as printed", () => {
    expect(figure("2000.0000")).toBe("2,000");
    expect(figure("0.0425")).toBe("0.0425");
    expect(figure("6.8500")).toBe("6.85");
    expect(figure("1.5000")).toBe("1.50");
  });

  it("names every document status in words", () => {
    expect(documentStatus("needs_review")).toEqual({ label: "Needs review", tone: "warning" });
    expect(documentStatus("failed").tone).toBe("risk");
  });
});

describe("uploadFiles", () => {
  const ok = {
    results: [
      {
        filename: "a.pdf",
        kind: "document",
        document: null,
        created: true,
        purchases: null,
        error: null,
      },
    ],
  };

  it("sends multipart form data and parses the answer with the contract", async () => {
    let sent: RequestInit | undefined;
    const res = await uploadFiles(
      [new File(["%PDF"], "a.pdf", { type: "application/pdf" })],
      async (_url, init) => {
        sent = init;
        return new Response(JSON.stringify(ok), { status: 200 });
      },
    );
    expect(res.results[0]?.kind).toBe("document");
    expect(sent?.body).toBeInstanceOf(FormData);
    expect((sent?.body as FormData | undefined)?.getAll("files")).toHaveLength(1);
  });

  it("fails as an ApiError with the server's code", async () => {
    const err = await uploadFiles([], async () =>
      Response.json({ error: { code: "invalid_request", message: "no files" } }, { status: 400 }),
    ).catch((e: unknown) => e);
    expect(isApiError(err) && err.code).toBe("invalid_request");
  });

  it("refuses an answer that breaks the contract", async () => {
    const err = await uploadFiles([], async () => Response.json({ nope: true })).catch(
      (e: unknown) => e,
    );
    expect(isApiError(err) && err.code).toBe("invalid_response");
  });
});
