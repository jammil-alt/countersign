// An agent's data sets (step model §10f): a set is added with read on the first record type,
// writing turns reading on, a write a record type doesn't allow can't be ticked, writing into
// another area is shown, and so is what the draft grants beyond the version it was opened on.
import type { AgentData } from "@countersign/core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { AppProviders } from "../../App";
import { fakeApi, OPERATOR_SESSION } from "../../test/fixtures";
import { DataSetsCard, dataSetId } from "./DataSetsCard";

const type = (id: string, area: string, update: boolean, create = false) => ({
  id,
  name: id,
  plural: `${id}s`,
  area,
  about: "x",
  fields: [{ name: "name", type: "text", required: true }],
  keys: [],
  links: [],
  operations: { create, update },
  writable: [],
  customFields: true,
});

function Harness({ seen }: { seen: AgentData[] }) {
  const [data, setData] = useState<AgentData | undefined>(undefined);
  return (
    <DataSetsCard
      value={data}
      opened={undefined}
      area="purchasing"
      onChange={(next) => {
        seen.push(next);
        setData(next);
      }}
    />
  );
}

describe("data sets", () => {
  it("makes a set's id from its name, unique among the agent's sets", () => {
    expect(dataSetId("Margin and ROI", [])).toBe("margin-and-roi");
    expect(dataSetId("Margin and ROI", ["margin-and-roi"])).toBe("margin-and-roi-2");
  });

  it("adds a set, grants within what each record type allows, and shows writes elsewhere", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/record-types": () => ({
        recordTypes: [
          type("vendor", "shared", false),
          type("bank_transaction", "bookkeeping", true),
        ],
        fields: [],
      }),
    });
    const seen: AgentData[] = [];
    render(
      <AppProviders client={api.client}>
        <Harness seen={seen} />
      </AppProviders>,
    );
    const user = userEvent.setup();
    await user.type(screen.getByTestId("agent-editor-data-name"), "Margin and ROI");
    // Enabled once the record types have loaded.
    await waitFor(() => expect(screen.getByTestId("agent-editor-data-add")).toBeEnabled());
    await user.click(screen.getByTestId("agent-editor-data-add"));
    const set = "agent-editor-data-set-margin-and-roi";
    expect(await screen.findByTestId(set)).toHaveTextContent("Margin and ROI");
    expect(screen.getByTestId(`${set}-vendor-read`)).toBeChecked();
    // Vendors can't be changed here; bank transactions can.
    expect(screen.getByTestId(`${set}-vendor-update`)).toBeDisabled();
    await user.click(screen.getByTestId(`${set}-bank_transaction-update`));
    expect(screen.getByTestId(`${set}-bank_transaction-read`)).toBeChecked();
    expect(seen.at(-1)?.sets[0]?.grants).toEqual([
      { recordType: "vendor", read: true, create: false, update: false },
      { recordType: "bank_transaction", read: true, create: false, update: true },
    ]);
    expect(screen.getByTestId("agent-editor-data-elsewhere")).toHaveTextContent(
      "bank_transactions (bookkeeping)",
    );
    expect(screen.getByTestId("agent-editor-data-widened")).toHaveTextContent(
      "read bank_transaction, read vendor, update bank_transaction",
    );
    await user.click(screen.getByTestId(`${set}-toggle`));
    expect(screen.getByTestId(`${set}-state`)).toHaveTextContent("Off");
    expect(screen.queryByTestId("agent-editor-data-elsewhere")).toBeNull();
  });
});
