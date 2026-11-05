// The portal's Access page (docs/plan.md §1.26): every vault item with whether its secret is
// stored (never the secret), each agent's access; the client admin enters an API-key tool's login,
// tightens (only stricter levels are offered) and revokes; a client user only reads.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { CLIENT_SESSION, fakeApi } from "../../test/fixtures";

const DEMO = CLIENT_SESSION.activeTenantId as string;
const CONN = "00000000-0000-4000-8000-0000000c0001";
const AGENT = "00000000-0000-4000-8000-0000000a0001";

const overview = {
  client: { id: DEMO, name: "Demo client" },
  services: [],
  needsYou: { inbox: 0 },
  recentRuns: [],
};

function vault(limits: Record<string, unknown> = {}) {
  const verbs = (limits.verbs ?? {}) as Record<string, string>;
  const effective = {
    read: verbs.read ?? "auto",
    create: verbs.create ?? "approval",
    update: verbs.update ?? "approval",
    delete: "off",
  };
  return {
    connectionId: CONN,
    connector: "acme",
    name: "Acme supplies",
    kind: "api_key",
    status: "connected",
    externalAccountId: null,
    secret: {
      set: true,
      fields: [
        {
          name: "username",
          label: "Username",
          secret: false,
          hint: null,
          set: true,
          value: "agent@demo.example.com",
        },
        { name: "password", label: "Password", secret: true, hint: null, set: true, value: null },
      ],
      updatedAt: "2026-11-05T10:00:00.000Z",
    },
    credentialForm: true,
    matrix: { read: "auto", create: "approval", update: "approval", delete: "off" },
    tools: [
      { id: "acme.price.get", description: "Read a price", verb: "read" },
      { id: "acme.order.create", description: "Place an order", verb: "create" },
    ],
    agents: [
      {
        agentId: AGENT,
        name: "Purchasing",
        limits,
        effective,
        tools: (limits.tools as string[] | undefined) ?? null,
        revoked: Object.values(effective).every((l) => l === "off"),
        updatedAt: null,
      },
    ],
  };
}

function renderAt(api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={["/access"]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

describe("portal access page", () => {
  it("shows what is set, never a secret, and each agent's access", async () => {
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () => overview,
      "GET /api/access": () => ({ items: [vault()], setup: [], canEdit: true }),
    });
    renderAt(api);
    const card = await screen.findByTestId("vault-item-acme");
    expect(within(card).getByTestId("vault-secret-state")).toHaveTextContent("Secret stored");
    const fields = within(card).getByTestId("vault-fields");
    expect(fields).toHaveTextContent("agent@demo.example.com");
    expect(fields).toHaveTextContent("PasswordSet");
    const agent = within(card).getByTestId(`vault-agent-${AGENT}`);
    expect(within(agent).getByTestId("vault-agent-create")).toHaveTextContent("create · Approval");
    expect(agent).toHaveTextContent("All tools");
  });

  it("tightens: offers only the current level or stricter, and sends only the tightening", async () => {
    const puts: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () => overview,
      "GET /api/access": () => ({ items: [vault()], setup: [], canEdit: true }),
      [`PUT /api/access/agents/${AGENT}/connections/${CONN}`]: ({ init }) => {
        puts.push(JSON.parse(String(init.body)));
        return { item: vault({ verbs: { create: "off" }, tools: ["acme.price.get"] }) };
      },
    });
    renderAt(api);
    const agent = await screen.findByTestId(`vault-agent-${AGENT}`);
    await userEvent.click(within(agent).getByTestId("vault-agent-tighten"));
    const create = within(agent).getByTestId("vault-agent-level-create");
    const levels = within(create)
      .getAllByRole("option")
      .map((o) => o.textContent);
    // From approval: approval or off, never auto.
    expect(levels).toEqual(["Approval", "Off"]);
    await userEvent.selectOptions(create, "off");
    await userEvent.click(within(agent).getByTestId("vault-agent-tool-acme.order.create"));
    await userEvent.click(within(agent).getByTestId("vault-agent-save"));
    await waitFor(() => expect(puts.length).toBe(1));
    expect(puts[0]).toEqual({ limits: { verbs: { create: "off" }, tools: ["acme.price.get"] } });
  });

  it("revokes after a warning", async () => {
    const puts: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () => overview,
      "GET /api/access": () => ({ items: [vault()], setup: [], canEdit: true }),
      [`PUT /api/access/agents/${AGENT}/connections/${CONN}`]: ({ init }) => {
        puts.push(JSON.parse(String(init.body)));
        return { item: vault() };
      },
    });
    renderAt(api);
    const agent = await screen.findByTestId(`vault-agent-${AGENT}`);
    await userEvent.click(within(agent).getByTestId("vault-agent-revoke"));
    expect(agent).toHaveTextContent("Purchasing stops using Acme supplies at once.");
    await userEvent.click(within(agent).getByTestId("vault-agent-revoke-confirm"));
    await waitFor(() => expect(puts.length).toBe(1));
    expect(puts[0]).toEqual({
      limits: { verbs: { read: "off", create: "off", update: "off", delete: "off" } },
    });
  });

  it("enters a tool's login: every field, secrets as password fields, cleared once saved", async () => {
    const puts: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () => overview,
      "GET /api/access": () => ({
        items: [],
        setup: [
          {
            connector: "acme",
            name: "Acme supplies",
            description: "A supplier's API",
            fields: [
              { name: "username", label: "Username", secret: false },
              { name: "password", label: "Password", secret: true, hint: "From Acme's settings" },
            ],
          },
        ],
        canEdit: true,
      }),
      "PUT /api/connections/acme/credentials": ({ init }) => {
        puts.push(JSON.parse(String(init.body)));
        return { item: vault() };
      },
    });
    renderAt(api);
    const form = await screen.findByTestId("vault-form-acme");
    const save = within(form).getByTestId("vault-form-save");
    expect(save).toBeDisabled();
    const password = within(form).getByTestId("vault-field-password");
    expect(password).toHaveAttribute("type", "password");
    await userEvent.type(
      within(form).getByTestId("vault-field-username"),
      "agent@demo.example.com",
    );
    await userEvent.type(password, "s3cret");
    await userEvent.click(save);
    await waitFor(() => expect(puts.length).toBe(1));
    expect(puts[0]).toEqual({ values: { username: "agent@demo.example.com", password: "s3cret" } });
    await waitFor(() => expect(password).toHaveValue(""));
  });

  it("a client user reads it all and changes nothing", async () => {
    const api = fakeApi({
      "GET /api/session": () => ({
        ...CLIENT_SESSION,
        tenants: [{ id: DEMO, name: "Demo client", role: "client_user" }],
      }),
      "GET /api/overview": () => overview,
      "GET /api/access": () => ({ items: [vault()], setup: [], canEdit: false }),
    });
    renderAt(api);
    const card = await screen.findByTestId("vault-item-acme");
    expect(within(card).queryByTestId("vault-agent-tighten")).toBeNull();
    expect(within(card).queryByTestId("vault-replace")).toBeNull();
    expect(within(card).queryByTestId("vault-disconnect")).toBeNull();
  });
});
