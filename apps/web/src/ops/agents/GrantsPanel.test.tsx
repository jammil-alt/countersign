// The back office's access section on a client agent: each bound connection with its grant, levels
// offered only up to the connection's matrix, an optional tool subset, saved through the API; never
// a secret, only whether one is stored.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ApiProvider } from "../../api/useApi";
import { fakeApi } from "../../test/fixtures";
import { GrantsPanel } from "./GrantsPanel";

const AGENT = "00000000-0000-4000-8000-0000000a0001";
const CONN = "00000000-0000-4000-8000-0000000c0001";

const grant = (limits: Record<string, unknown> = {}) => ({
  connector: "acme",
  connectorName: "Acme supplies",
  connectionId: CONN,
  status: "connected",
  externalAccountId: null,
  kind: "api_key",
  secretSet: true,
  matrix: { read: "auto", create: "approval", update: "approval", delete: "off" },
  tools: [
    { id: "acme.price.get", description: "Read a price", verb: "read" },
    { id: "acme.order.create", description: "Place an order", verb: "create" },
  ],
  access: {
    agentId: AGENT,
    name: "Purchasing",
    limits,
    effective: { read: "auto", create: "approval", update: "approval", delete: "off" },
    tools: null,
    revoked: false,
    updatedAt: null,
  },
});

describe("grants panel", () => {
  it("offers levels up to the matrix, and saves a read-only grant with a tool subset", async () => {
    const puts: unknown[] = [];
    const api = fakeApi({
      [`GET /api/ops/agents/${AGENT}/grants`]: () => ({ grants: [grant()] }),
      [`PUT /api/ops/agents/${AGENT}/grants/${CONN}`]: ({ init }) => {
        const body = JSON.parse(String(init.body));
        puts.push(body);
        return { grant: grant(body.limits) };
      },
    });
    render(
      <ApiProvider client={api.client}>
        <MemoryRouter>
          <GrantsPanel agentId={AGENT} />
        </MemoryRouter>
      </ApiProvider>,
    );
    const row = await screen.findByTestId("agent-grant-acme");
    expect(row).toHaveTextContent("Secret stored");
    const create = within(row).getByTestId("agent-grant-acme-create");
    // The matrix has create at approval: auto is not offered.
    expect(
      within(create)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["As the connection allows", "Approval", "Off"]);
    const save = within(row).getByTestId("agent-grant-acme-save");
    expect(save).toBeDisabled();
    await userEvent.selectOptions(create, "off");
    await userEvent.selectOptions(within(row).getByTestId("agent-grant-acme-update"), "off");
    await userEvent.click(within(row).getByTestId("agent-grant-acme-limit-tools"));
    await userEvent.click(within(row).getByTestId("agent-grant-tool-acme.order.create"));
    await userEvent.click(save);
    await waitFor(() => expect(puts.length).toBe(1));
    expect(puts[0]).toEqual({
      limits: { verbs: { create: "off", update: "off" }, tools: ["acme.price.get"] },
    });
  });
});
