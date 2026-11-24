// Describe the skill (owner, 2026-11-24: "the skill process uses the old flow ... allow the upload
// of a file like excel or csv or pdf, jpeg etc ... then with words specify the input and the
// output"), through the API with scripted model answers. A sample spreadsheet is read in code as
// Read table reads one (its columns and first rows as JSON, nothing stored); a skill build is
// drafted at once from the words and the sample, which the Builder sees as data and whose first
// rows become a test case; a sample is refused on an agent build; a failed draft leaves the build
// where it was.
import type { BuildDetail, SkillSampleView } from "@countersign/core";
import { FakeModel, type LlmRequest } from "@countersign/llm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createApiHarness, OPERATOR } from "./api.test-helper";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const model = new FakeModel();
const h = await createApiHarness({ llm: model });
afterAll(() => h?.close());

const CSV = [
  "Debtor Name,County,Filing Type,Filing Date",
  "Acme Paving LLC,Harris,Original,10/02/2026",
  "Acme Paving LLC,Harris,Amendment,10/09/2026",
  "Gulf Site Works,Fort Bend,Original,10/14/2026",
].join("\n");

const file = (filename: string, text: string, mimeType = "") => ({
  filename,
  mimeType,
  base64: Buffer.from(text, "utf8").toString("base64"),
});

const WORDS =
  "What it gets: the UCC filings, one a row.\n\nWhat it gives back: kept, the filings that stay; removed, each with its reason.";

const definition = {
  slug: "filter-ucc-filings",
  name: "Filter UCC filings",
  description: "Keeps the filings that matter and says why the rest were taken out",
  category: "data",
  mode: "task",
  model: { id: "claude-haiku-5-5" },
  instructions: "Remove amendments and refinances.",
  tools: [],
  input: { type: "object", properties: { rows: { type: "array" } } },
  output: { type: "object", properties: { kept: { type: "array" }, removed: { type: "array" } } },
  settings: [],
  producesAlerts: false,
};

describe.skipIf(!h)("describe the skill", () => {
  const H = h as NonNullable<typeof h>;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await H.call(OPERATOR, method, path, body);
    return { status: res.status, json: res.json as unknown };
  };
  const ok = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await call(method, path, body);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json as T;
  };
  const errorOf = (json: unknown) => (json as { error: { code: string } }).error.code;

  it("reads a sample spreadsheet into Read table's columns and JSON rows, storing nothing", async () => {
    const view = await ok<SkillSampleView>("POST", "/api/ops/skills/sample", {
      file: file("ucc.csv", CSV, "text/csv"),
    });
    expect(view.kind).toBe("table");
    expect(view.table?.rowCount).toBe(3);
    expect(view.table?.columns.map((c) => [c.field, c.headers[0], c.type])).toEqual([
      ["debtor_name", "Debtor Name", "text"],
      ["county", "County", "text"],
      ["filing_type", "Filing Type", "text"],
      ["filing_date", "Filing Date", "date"],
    ]);
    // Keyed and typed as a Read table step gives them: dates as YYYY-MM-DD.
    expect(view.table?.rows[1]).toEqual({
      debtor_name: "Acme Paving LLC",
      county: "Harris",
      filing_type: "Amendment",
      filing_date: "2026-10-09",
    });
    const pdf = await ok<SkillSampleView>("POST", "/api/ops/skills/sample", {
      file: file("notice.pdf", "%PDF-1.4", "application/pdf"),
    });
    expect(pdf).toMatchObject({ kind: "document", table: null, failure: null });
    const other = await ok<SkillSampleView>("POST", "/api/ops/skills/sample", {
      file: file("notes.docx", "not a table"),
    });
    expect(other.kind).toBe("other");
    expect(other.failure).toContain("isn't a file we read");
  });

  it("drafts a skill build at once from the words and the sample, its rows a test case", async () => {
    const started = await ok<BuildDetail>("POST", "/api/ops/builds", {
      kind: "skill",
      title: "Filter UCC filings",
    });
    const id = started.build.id;
    let seen: LlmRequest | undefined;
    model.push((req: LlmRequest) => {
      seen = req;
      return {
        toolUse: {
          name: "submit_skill",
          input: {
            text: "Drafted the filter with one test from your sample.",
            gaps: [],
            definition,
            cases: [
              { example: 1, expected: { kept: [], removed: [] }, matcher: { kind: "subset" } },
            ],
          },
        },
      };
    });
    const detail = await ok<BuildDetail>("POST", `/api/ops/builds/${id}/draft-now`, {
      description: WORDS,
      sample: file("ucc.csv", CSV, "text/csv"),
    });
    expect(detail.build.phase).toBe("draft");
    const sessionId = detail.draft?.sessionId;
    expect(sessionId).toBeTruthy();
    // The Builder saw the words and the sample's first rows, as data.
    const prompt = seen?.messages[0]?.content as string;
    expect(prompt).toContain("What it gives back: kept");
    expect(prompt).toContain("<sample_file>");
    expect(prompt).toContain("Gulf Site Works");
    const session = await ok<{
      session: { bundle: { cases: { name: string; input: { rows: unknown[] } }[] } };
      turns: { role: string; sample?: { filename: string; kind: string } }[];
    }>("GET", `/api/ops/builder/sessions/${sessionId}`);
    // The operator's turn keeps the sample's name and kind; the file itself is not kept.
    const said = session.turns.filter((t) => t.role === "operator");
    expect(said.at(-1)).toMatchObject({ sample: { filename: "ucc.csv", kind: "table" } });
    const cases = session.session.bundle.cases;
    expect(cases).toHaveLength(1);
    expect(cases[0]?.name).toBe("First rows of ucc.csv");
    expect(cases[0]?.input.rows).toHaveLength(3);
    // Drafted once: a second try is refused.
    const again = await call("POST", `/api/ops/builds/${id}/draft-now`, { description: WORDS });
    expect(again.status).toBe(409);
  });

  it("puts a skill build back where it was when its draft fails", async () => {
    const started = await ok<BuildDetail>("POST", "/api/ops/builds", {
      kind: "skill",
      title: "Read lien notices",
    });
    const id = started.build.id;
    model.push(() => {
      throw new Error("the model is down");
    });
    const res = await call("POST", `/api/ops/builds/${id}/draft-now`, { description: WORDS });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const after = await ok<BuildDetail>("GET", `/api/ops/builds/${id}`);
    expect(after.build.phase).toBe("intake");
    expect(after.draft?.sessionId ?? null).toBeNull();
  });

  it("refuses a sample on an agent build, and a file that isn't one", async () => {
    const started = await ok<BuildDetail>("POST", "/api/ops/builds", {
      kind: "agent",
      title: "Record fixer",
    });
    const res = await call("POST", `/api/ops/builds/${started.build.id}/draft-now`, {
      description: "Fix records when asked.",
      sample: file("ucc.csv", CSV, "text/csv"),
    });
    expect(res.status).toBe(422);
    const skill = await ok<BuildDetail>("POST", "/api/ops/builds", {
      kind: "skill",
      title: "Unreadable",
    });
    const bad = await call("POST", `/api/ops/builds/${skill.build.id}/draft-now`, {
      description: WORDS,
      sample: file("notes.docx", "not a table"),
    });
    expect(bad.status).toBe(422);
    expect(errorOf(bad.json)).toBe("sample_unreadable");
    const after = await ok<BuildDetail>("GET", `/api/ops/builds/${skill.build.id}`);
    expect(after.build.phase).toBe("intake");
  });
});
