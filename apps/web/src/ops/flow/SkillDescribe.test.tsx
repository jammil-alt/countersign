// Describe the skill (owner, 2026-11-24): a sample file read on the spot (a spreadsheet's rows as
// JSON), then in words what it gets and gives back; Draft the skill starts a skill build, drafts
// it at once with the words and the sample, and opens its conversation.
import type { BuildDetail, SkillSampleView } from "@countersign/core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ApiProvider } from "../../api/useApi";
import { fakeApi } from "../../test/fixtures";
import { BUILD_ID, buildDetail } from "./checkFixtures";
import { SkillDescribe, skillWords } from "./SkillDescribe";

const SESSION = "01a20000-0000-7000-8000-00000000c0de";

function Where() {
  const l = useLocation();
  return <p data-testid="location">{`${l.pathname}${l.search}`}</p>;
}

function skillBuild(drafted: boolean): BuildDetail {
  const d = buildDetail();
  return {
    ...d,
    build: {
      ...d.build,
      kind: "skill",
      title: "Filter UCC filings",
      phase: drafted ? "draft" : "intake",
    },
    draft: drafted
      ? {
          agentId: null,
          skillId: null,
          sessionId: SESSION,
          versionId: null,
          version: null,
          live: false,
          problems: [],
          steps: [],
        }
      : null,
  };
}

const TABLE: SkillSampleView = {
  filename: "ucc.csv",
  mimeType: "text/csv",
  kind: "table",
  table: {
    sheet: null,
    sheets: [],
    columns: [
      { field: "debtor_name", headers: ["Debtor Name"], type: "text", required: true },
      { field: "county", headers: ["County"], type: "text", required: true },
    ],
    rows: [{ debtor_name: "Acme Paving LLC", county: "Harris" }],
    rowCount: 412,
    failure: null,
  },
  failure: null,
};

function renderIt(api: ReturnType<typeof fakeApi>, applyAccept = true) {
  render(
    <MemoryRouter initialEntries={["/ops/lab"]}>
      <ApiProvider client={api.client}>
        <Routes>
          <Route path="/ops/lab" element={<SkillDescribe />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </ApiProvider>
    </MemoryRouter>,
  );
  return userEvent.setup({ applyAccept });
}

describe("Describe the skill", () => {
  it("reads the sample as JSON, then drafts the skill from the words and the sample", async () => {
    const bodies: Record<string, unknown> = {};
    const api = fakeApi({
      "POST /api/ops/skills/sample": ({ init }) => {
        bodies.sample = JSON.parse(String(init.body));
        return TABLE;
      },
      "POST /api/ops/builds": ({ init }) => {
        bodies.build = JSON.parse(String(init.body));
        return skillBuild(false);
      },
      [`POST /api/ops/builds/${BUILD_ID}/draft-now`]: ({ init }) => {
        bodies.draft = JSON.parse(String(init.body));
        return skillBuild(true);
      },
    });
    const user = renderIt(api);
    expect(screen.getByTestId("skill-describe-draft")).toBeDisabled();
    await user.type(screen.getByTestId("skill-describe-name"), "Filter UCC filings");
    await user.upload(
      screen.getByTestId("skill-describe-sample-file"),
      new File(["Debtor Name,County\nAcme Paving LLC,Harris\n"], "ucc.csv", { type: "text/csv" }),
    );
    // The file as Read table reads it: its columns, how many rows, and the rows as JSON.
    expect(await screen.findByTestId("skill-describe-sample-summary")).toHaveTextContent(
      "412 rows and 2 columns",
    );
    expect(screen.getByTestId("skill-describe-sample-json")).toHaveTextContent(
      '"debtor_name": "Acme Paving LLC"',
    );
    expect(bodies.sample).toMatchObject({ file: { filename: "ucc.csv", mimeType: "text/csv" } });
    // A name and a sample aren't enough: it needs the words.
    expect(screen.getByTestId("skill-describe-draft")).toBeDisabled();
    await user.type(screen.getByTestId("skill-describe-gets"), "The UCC filings, one a row.");
    await user.type(screen.getByTestId("skill-describe-gives"), "kept and removed, with reasons.");
    await user.click(screen.getByTestId("skill-describe-draft"));
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        `/ops/skills/new?session=${SESSION}`,
      ),
    );
    expect(api.calls).toEqual([
      "POST /api/ops/skills/sample",
      "POST /api/ops/builds",
      `POST /api/ops/builds/${BUILD_ID}/draft-now`,
    ]);
    expect(bodies.build).toEqual({ kind: "skill", title: "Filter UCC filings" });
    expect(bodies.draft).toMatchObject({
      description:
        "What it gets: The UCC filings, one a row.\n\nWhat it gives back: kept and removed, with reasons.\n\nSample file: ucc.csv",
      sample: { filename: "ucc.csv" },
    });
  });

  it("says a PDF or an image is read by the skill, and refuses a file it can't read", async () => {
    let view: SkillSampleView = {
      filename: "notice.pdf",
      mimeType: "application/pdf",
      kind: "document",
      table: null,
      failure: null,
    };
    const api = fakeApi({ "POST /api/ops/skills/sample": () => view });
    // The picker offers only the files we read; a dropped one is still checked by the server.
    const user = renderIt(api, false);
    const input = screen.getByTestId("skill-describe-sample-file");
    await user.upload(input, new File(["%PDF"], "notice.pdf", { type: "application/pdf" }));
    expect(await screen.findByTestId("skill-describe-sample-document")).toHaveTextContent(
      "A PDF: the skill reads it with a model",
    );
    view = {
      filename: "notes.docx",
      mimeType: "",
      kind: "other",
      table: null,
      failure: "notes.docx isn't a file we read",
    };
    await user.upload(input, new File(["x"], "notes.docx"));
    expect(await screen.findByTestId("skill-describe-sample-error")).toHaveTextContent(
      "isn't a file we read",
    );
    await user.type(screen.getByTestId("skill-describe-name"), "Read notices");
    await user.type(screen.getByTestId("skill-describe-gets"), "A notice.");
    expect(screen.getByTestId("skill-describe-draft")).toBeDisabled();
  });

  it("puts the words under their headings, leaving out the empty ones", () => {
    expect(skillWords({ gets: " A file ", gives: "", does: "Sort it.", sample: null })).toBe(
      "What it gets: A file\n\nWhat it does: Sort it.",
    );
  });
});
