import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type MatrixRow, MatrixTable } from "./MatrixTable";
import { allowedLevels } from "./matrix";

const ROW: MatrixRow = {
  id: "00000000-0000-4000-8000-00000000c001",
  name: "Testkit",
  permissions: { read: "auto", create: "approval", update: "auto", delete: "off" },
};

const options = (select: HTMLElement) =>
  within(select)
    .getAllByRole("option")
    .map((o) => o.getAttribute("value"));

describe("allowedLevels", () => {
  it("lets a client admin keep the saved level or tighten it, never loosen", () => {
    expect(allowedLevels("update", "auto", "client_admin")).toEqual(["auto", "approval", "off"]);
    expect(allowedLevels("update", "approval", "client_admin")).toEqual(["approval", "off"]);
    expect(allowedLevels("create", "off", "client_admin")).toEqual(["off"]);
    expect(allowedLevels("read", "auto", "client_admin")).toEqual(["auto", "off"]);
  });

  it("lets the operator loosen, keeps delete off for everyone, and gives viewers nothing", () => {
    expect(allowedLevels("update", "off", "operator")).toEqual(["auto", "approval", "off"]);
    expect(allowedLevels("delete", "off", "operator")).toEqual(["off"]);
    expect(allowedLevels("delete", "off", "client_admin")).toEqual(["off"]);
    expect(allowedLevels("update", "auto", "viewer")).toEqual([]);
  });
});

describe("MatrixTable", () => {
  it("offers a client admin only the saved level or stricter, and saves only what changed", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <MatrixTable
        editor="client_admin"
        rows={[{ ...ROW, permissions: { ...ROW.permissions, update: "approval" } }]}
        onSave={onSave}
      />,
    );
    const row = screen.getByTestId(`matrix-row-${ROW.id}`);
    expect(options(within(row).getByTestId("matrix-update-select"))).toEqual(["approval", "off"]);
    expect(options(within(row).getByTestId("matrix-create-select"))).toEqual(["approval", "off"]);
    // Delete is pinned off: a badge, not a choice.
    expect(within(row).queryByTestId("matrix-delete-select")).toBeNull();
    expect(within(row).getByTestId("matrix-delete-level")).toHaveTextContent("Off");
    // Clients never edit the scope.
    expect(within(row).queryByTestId("matrix-scope-input")).toBeNull();

    expect(screen.queryByTestId("matrix-changes-save")).toBeNull();
    await userEvent.selectOptions(within(row).getByTestId("matrix-update-select"), "off");
    expect(screen.getByText(/Only we can loosen them again/)).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("matrix-changes-save"));
    expect(onSave).toHaveBeenCalledWith(ROW.id, { update: "off" });
  });

  it("drops an edit set back to the saved level", async () => {
    const onSave = vi.fn();
    render(<MatrixTable editor="client_admin" rows={[ROW]} onSave={onSave} />);
    const select = screen.getByTestId("matrix-update-select");
    await userEvent.selectOptions(select, "off");
    expect(screen.getByTestId("matrix-changes-save")).toBeInTheDocument();
    await userEvent.selectOptions(select, "auto");
    expect(screen.queryByTestId("matrix-changes-save")).toBeNull();
  });

  it("shows a client user the matrix read-only", () => {
    render(<MatrixTable editor="viewer" rows={[ROW]} />);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByTestId("matrix-update-level")).toHaveTextContent("Auto");
    expect(screen.getByTestId("matrix-create-level")).toHaveTextContent("Approval");
  });

  it("lets the operator loosen and set the scope, and shows a refused save", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("delete stays off in v1"));
    render(
      <MatrixTable
        editor="operator"
        rows={[{ ...ROW, permissions: { ...ROW.permissions, create: "off" } }]}
        onSave={onSave}
      />,
    );
    expect(options(screen.getByTestId("matrix-create-select"))).toEqual([
      "auto",
      "approval",
      "off",
    ]);
    await userEvent.selectOptions(screen.getByTestId("matrix-create-select"), "approval");
    await userEvent.type(screen.getByTestId("matrix-scope-input"), "AP folder");
    await userEvent.click(screen.getByTestId("matrix-changes-save"));
    expect(onSave).toHaveBeenCalledWith(ROW.id, { create: "approval", scope: "AP folder" });
    expect(await screen.findByRole("alert")).toHaveTextContent("delete stays off");
  });
});

// v0.12 W2-A: record types under each tool (docs/plan.md §1.44).
describe("MatrixTable entity rows", () => {
  const ENTITIES = [
    { id: "bill", label: "Bills", verbs: ["read", "create", "update"] as const },
    {
      id: "invoice",
      label: "Invoices",
      verbs: ["read", "update"] as const,
      scopes: [
        { id: "notes_only", label: "Notes only", verb: "update" as const, tools: ["x.add_note"] },
      ],
    },
  ].map((e) => ({ ...e, verbs: [...e.verbs] }));
  const WITH = {
    ...ROW,
    permissions: { ...ROW.permissions, update: "approval" as const },
    entities: ENTITIES,
  };

  it("shows each entity's level (the stricter of verb and entity) and offers a client only tighter", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <MatrixTable
        editor="client_admin"
        rows={[
          { ...WITH, permissions: { ...WITH.permissions, entities: { bill: { create: "off" } } } },
        ]}
        onSave={onSave}
      />,
    );
    const bills = screen.getByTestId(`matrix-entity-${ROW.id}-bill`);
    expect(bills).toHaveTextContent("Bills");
    expect(within(bills).getByTestId("matrix-entity-bill-create-level")).toHaveTextContent("Off");
    expect(options(within(bills).getByTestId("matrix-entity-bill-update-select"))).toEqual([
      "approval",
      "off",
    ]);
    // Invoices have no create.
    expect(
      within(screen.getByTestId(`matrix-entity-${ROW.id}-invoice`)).getAllByText("—"),
    ).toHaveLength(2);
    await userEvent.selectOptions(
      within(bills).getByTestId("matrix-entity-bill-update-select"),
      "off",
    );
    await userEvent.selectOptions(
      screen.getByTestId("matrix-entity-invoice-scope-select"),
      "notes_only",
    );
    await userEvent.click(screen.getByTestId("matrix-changes-save"));
    expect(onSave).toHaveBeenCalledWith(ROW.id, {
      entities: {
        bill: { create: "off", update: "off" },
        invoice: { scope: { update: "notes_only" } },
      },
    });
  });

  it("doesn't let a client drop a scope set before", () => {
    render(
      <MatrixTable
        editor="client_admin"
        rows={[
          {
            ...WITH,
            permissions: {
              ...WITH.permissions,
              entities: { invoice: { scope: { update: "notes_only" } } },
            },
          },
        ]}
        onSave={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("matrix-entity-invoice-scope-select")).toBeNull();
    expect(screen.getByTestId("matrix-entity-invoice-scope")).toHaveTextContent("Notes only");
  });
});
