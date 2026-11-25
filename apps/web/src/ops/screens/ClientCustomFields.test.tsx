// The client settings' Custom fields section (step model §10f): a record type's built-in and added
// fields, a field added for this client or every client (its stored name made from its words), the
// server's refusal shown, and a field removed (hidden, its data kept).
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION, Reply } from "../../test/fixtures";
import { fieldNameOf } from "./ClientCustomFields";

const DEMO = "00000000-0000-4000-8000-00000000a002";

const VENDOR = {
  id: "vendor",
  name: "Vendor",
  plural: "Vendors",
  area: "shared",
  about: "A business the client buys from.",
  fields: [{ name: "name", type: "text", required: true }],
  keys: [],
  links: [],
  operations: { create: false, update: true },
  writable: [],
  customFields: true,
};

const field = (over: Record<string, unknown>) => ({
  id: "f1",
  recordType: "vendor",
  name: "region",
  label: "Region",
  type: "text",
  spec: {},
  required: false,
  about: "",
  scope: "client",
  hidden: false,
  clientId: DEMO,
  createdAt: "2026-11-25T00:00:00Z",
  ...over,
});

function setup(handlers: Record<string, Parameters<typeof fakeApi>[0][string]>) {
  const api = fakeApi({
    "GET /api/session": () => OPERATOR_SESSION,
    [`GET /api/ops/clients/${DEMO}`]: () => ({
      client: { id: DEMO, name: "Demo client", timezone: "UTC", settings: {}, createdAt: "x" },
      agents: [],
      connections: [],
      members: [],
    }),
    ...handlers,
  });
  render(
    <MemoryRouter initialEntries={[`/ops/clients/${DEMO}/settings/fields`]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
  return api;
}

describe("custom fields", () => {
  it("makes a stored name from a field's words", () => {
    expect(fieldNameOf("Credit limit")).toBe("creditLimit");
    expect(fieldNameOf("  Net 30 terms! ")).toBe("net30Terms");
    expect(fieldNameOf("30 day terms")).toBe("f30DayTerms");
  });

  it("lists built-in and added fields, adds one for every client, and removes one", async () => {
    let fields = [field({})];
    const sent: unknown[] = [];
    setup({
      "GET /api/ops/record-types": () => ({ recordTypes: [VENDOR], fields }),
      "POST /api/ops/custom-fields": ({ init }) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        sent.push(body);
        if (body.name === "name") {
          return new Reply(422, {
            error: { code: "invalid_field", message: "vendor already has a field name" },
          });
        }
        fields = [...fields, field({ id: "f2", ...body, scope: "shared", clientId: null })];
        return { field: fields.at(-1) };
      },
      "PATCH /api/ops/custom-fields/f1": ({ init }) => {
        const body = JSON.parse(String(init.body)) as { hidden: boolean };
        sent.push(body);
        fields = fields.map((f) => (f.id === "f1" ? { ...f, hidden: body.hidden } : f));
        return { field: fields[0] };
      },
    });
    const user = userEvent.setup();
    const table = await screen.findByTestId("ops-custom-fields-table");
    expect(within(table).getByText("Built in")).toBeInTheDocument();
    expect(within(table).getByTestId("ops-custom-field-region")).toHaveTextContent("This client");

    await user.type(screen.getByTestId("ops-custom-field-label"), "Name");
    await user.click(screen.getByTestId("ops-custom-field-save"));
    expect(await screen.findByTestId("ops-custom-field-error")).toHaveTextContent(
      "vendor already has a field name",
    );

    await user.clear(screen.getByTestId("ops-custom-field-label"));
    await user.type(screen.getByTestId("ops-custom-field-label"), "Payment terms");
    await user.selectOptions(screen.getByTestId("ops-custom-field-scope"), "shared");
    await user.click(screen.getByTestId("ops-custom-field-save"));
    await waitFor(() =>
      expect(screen.getByTestId("ops-custom-field-paymentTerms")).toHaveTextContent("Every client"),
    );
    expect(sent[1]).toEqual({
      recordType: "vendor",
      name: "paymentTerms",
      label: "Payment terms",
      type: "text",
      spec: {},
      required: false,
      about: "",
    });

    await user.click(screen.getByTestId("ops-custom-field-region-remove"));
    await waitFor(() =>
      expect(screen.getByTestId("ops-custom-field-region")).toHaveTextContent("Removed"),
    );
    expect(sent.at(-1)).toEqual({ hidden: true });
  });
});
