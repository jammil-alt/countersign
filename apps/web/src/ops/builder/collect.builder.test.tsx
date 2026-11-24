// Collect reports (owner, 2026-11-24) in the builder: a report's owner, frequency, format,
// columns from a sample file, due date and follow-ups; the escalation and what happens when a
// report never comes. On a fake API: the sample goes to the server, which answers its columns.
import { type CollectSampleView, processes } from "@countersign/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { ApiProvider } from "../../api/useApi";
import { fakeApi } from "../../test/fixtures";
import { CollectFields } from "./collect-step";
import { createStep, type Step } from "./model";
import type { People } from "./people";

const AGENT_ID = "00000000-0000-4000-8000-00000000b401";
const CONTACT = "00000000-0000-4000-8000-00000000c101";

type CollectStep = Extract<Step, { kind: "collect" }>;

const people: People = {
  members: [{ userId: "u-dana", email: "dana@client.test", name: "Dana", role: "client_admin" }],
  people: [{ id: CONTACT, name: "Pat at the bank", kind: "contact" }],
};
const bundle = { people: [{ role: "controller", label: "Controller" }] };

function Harness({ onStep }: { onStep(s: CollectStep): void }) {
  const [step, setStep] = useState(
    () =>
      createStep(
        { type: "collect", key: "collect", title: "Collect reports", detail: "" },
        {},
        () => "c1",
      ) as CollectStep,
  );
  return (
    <CollectFields
      step={step}
      bundle={bundle}
      people={people}
      fieldErrors={{ at: () => [] }}
      agentId={AGENT_ID}
      set={(_key, fn) =>
        setStep((s) => {
          const next = fn(s);
          onStep(next);
          return next;
        })
      }
    />
  );
}

describe("the collect step's form", () => {
  it("starts with one report and an escalation to the client admin, approval on", () => {
    const step = createStep(
      { type: "collect", key: "collect", title: "Collect reports", detail: "" },
      {},
      () => "c1",
    );
    expect(step).toMatchObject({
      kind: "collect",
      items: [{ id: "r1", owner: "", frequency: "monthly", followUp: { max: 2 } }],
      escalate: { to: "client_admin", after: "3 days", hours: "business" },
      ifMissing: "stop",
    });
  });

  it("sets a report's owner, columns from a sample, dates, and the escalation", async () => {
    const sent: Record<string, unknown>[] = [];
    const answer: CollectSampleView = {
      format: "spreadsheet",
      filename: "bank-october.csv",
      columns: [
        { field: "date", headers: ["Date"], type: "date", dateStyle: "iso", required: true },
        { field: "amount", headers: ["Amount"], type: "money", required: true },
      ],
      sheet: null,
      rowCount: 42,
      failure: null,
    };
    const api = fakeApi({
      [`POST /api/ops/agents/${AGENT_ID}/collect/sample`]: ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        return answer;
      },
    });
    let last: CollectStep | undefined;
    const user = userEvent.setup();
    render(
      <ApiProvider client={api.client}>
        <Harness onStep={(s) => (last = s)} />
      </ApiProvider>,
    );

    await user.clear(screen.getByTestId("builder-collect-0-name"));
    await user.type(screen.getByTestId("builder-collect-0-name"), "Bank statement");
    await user.selectOptions(screen.getByTestId("builder-collect-0-owner"), "seat:controller");
    await user.selectOptions(screen.getByTestId("builder-collect-0-frequency"), "weekly");
    await user.upload(
      screen.getByTestId("builder-collect-0-sample-file"),
      new File(["Date,Amount\n2026-11-02,10.00\n"], "bank-october.csv", { type: "text/csv" }),
    );
    expect(await screen.findByTestId("builder-collect-0-sample-summary")).toHaveTextContent(
      "2 columns from 42 rows",
    );
    expect(sent[0]).toMatchObject({ file: { filename: "bank-october.csv", mimeType: "text/csv" } });
    await user.selectOptions(screen.getByTestId("builder-collect-0-dates"), "date");
    await user.clear(screen.getByTestId("builder-collect-0-follow-max"));
    await user.type(screen.getByTestId("builder-collect-0-follow-max"), "3");

    // A second report, from a contact, PDF only.
    await user.click(screen.getByTestId("builder-collect-add"));
    await user.selectOptions(screen.getByTestId("builder-collect-1-owner"), CONTACT);
    await user.click(screen.getByTestId("builder-collect-1-format-spreadsheet"));

    await user.selectOptions(screen.getByTestId("builder-collect-escalate-to"), "u-dana");
    await user.selectOptions(screen.getByTestId("builder-collect-if-missing"), "proceed");

    expect(last?.items[0]).toMatchObject({
      name: "Bank statement",
      owner: "seat:controller",
      frequency: "weekly",
      formats: ["pdf", "spreadsheet"],
      sample: { filename: "bank-october.csv" },
      columns: answer.columns,
      dates: { field: "date" },
      followUp: { max: 3 },
    });
    expect(last?.items[1]).toMatchObject({ id: "r2", owner: CONTACT, formats: ["pdf"] });
    expect(last?.escalate?.to).toBe("u-dana");
    expect(last?.ifMissing).toBe("proceed");
    // What the form made is a valid step.
    expect(processes.CollectStep.safeParse(last).success).toBe(true);
    expect(processes.collectProblems(last as CollectStep)).toEqual([]);
  });

  it("tells the operator the step's email tag", () => {
    render(
      <ApiProvider client={fakeApi({}).client}>
        <Harness onStep={() => {}} />
      </ApiProvider>,
    );
    expect(screen.getByTestId("builder-collect-email")).toHaveTextContent("+c1");
  });

  it("turns the escalation off and on, and keeps one report at least", async () => {
    let last: CollectStep | undefined;
    const user = userEvent.setup();
    render(
      <ApiProvider client={fakeApi({}).client}>
        <Harness onStep={(s) => (last = s)} />
      </ApiProvider>,
    );
    expect(screen.queryByTestId("builder-collect-0-remove")).toBeNull();
    await user.click(screen.getByTestId("builder-collect-escalate-on"));
    expect(last?.escalate).toBeUndefined();
    expect(screen.queryByTestId("builder-collect-escalate-to")).toBeNull();
    await user.click(screen.getByTestId("builder-collect-escalate-on"));
    expect(last?.escalate).toMatchObject({ to: "client_admin", after: "3 days" });
    // Spreadsheet checks show only while spreadsheets are allowed.
    await user.click(screen.getByTestId("builder-collect-0-format-spreadsheet"));
    expect(screen.queryByTestId("builder-collect-0-sheet")).toBeNull();
  });
});
