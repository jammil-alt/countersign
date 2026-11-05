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

const RELEASE_OFF = {
  mode: "off",
  person: null,
  channel: "email",
  window: "run",
  sentTo: null,
  updatedAt: null,
  live: [],
};

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
    release: RELEASE_OFF,
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
      "GET /api/access": () => ({ items: [vault()], setup: [], canEdit: true, people: [] }),
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
      "GET /api/access": () => ({ items: [vault()], setup: [], canEdit: true, people: [] }),
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
      "GET /api/access": () => ({ items: [vault()], setup: [], canEdit: true, people: [] }),
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
        people: [],
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
      "GET /api/access": () => ({ items: [vault()], setup: [], canEdit: false, people: [] }),
    });
    renderAt(api);
    const card = await screen.findByTestId("vault-item-acme");
    expect(within(card).queryByTestId("vault-agent-tighten")).toBeNull();
    expect(within(card).queryByTestId("vault-replace")).toBeNull();
    expect(within(card).queryByTestId("vault-disconnect")).toBeNull();
  });

  describe("website logins", () => {
    const BROWSER_CONN = "00000000-0000-4000-8000-0000000c0002";
    function browserItem(over: Record<string, unknown> = {}) {
      return {
        ...vault(),
        connectionId: BROWSER_CONN,
        connector: "browser",
        name: "Supplier portal",
        kind: "browser",
        status: "pending",
        secret: {
          set: false,
          fields: [
            {
              name: "username",
              label: "Agent account username",
              secret: false,
              hint: null,
              set: false,
              value: null,
            },
            {
              name: "password",
              label: "Agent account password",
              secret: true,
              hint: null,
              set: false,
              value: null,
            },
          ],
          updatedAt: null,
        },
        tools: [{ id: "browser.page.read", description: "Read a page", verb: "read" }],
        agents: [],
        browser: {
          site: { slug: "supplier", name: "Supplier portal", tier: "low" },
          effectiveTier: "low",
          siteVersion: 1,
          identity: { email: "agent-abcdefghijkl@agents.mezonas.com", phone: null },
          stricter: { noWrites: false, personSignIn: false },
          signInsPerDay: 10,
          signInsToday: 2,
          stopped: null,
          ...over,
        },
      };
    }

    it("sets a login up on an offered site after the confirmation, never on a blocked one", async () => {
      const posts: unknown[] = [];
      const api = fakeApi({
        "GET /api/session": () => CLIENT_SESSION,
        "GET /api/overview": () => overview,
        "GET /api/access": () => ({
          items: [],
          setup: [],
          browserSites: [
            { slug: "supplier", name: "Supplier portal", tier: "low", secondFactor: "email" },
            { slug: "orders", name: "Ordering portal", tier: "medium", secondFactor: "totp" },
          ],
          canEdit: true,
          people: [],
        }),
        "POST /api/access/browser": ({ init }) => {
          posts.push(JSON.parse(String(init.body)));
          return { connectionId: BROWSER_CONN };
        },
      });
      renderAt(api);
      const offer = await screen.findByTestId("vault-browser-offer-supplier");
      expect(within(offer).getByTestId("vault-browser-tier")).toHaveTextContent("Low risk");
      expect(offer).toHaveTextContent("Changes need your approval unless you allow them.");
      const submit = within(offer).getByTestId("vault-browser-setup-submit");
      expect(submit).toBeDisabled();
      await userEvent.click(within(offer).getByTestId("vault-browser-confirm"));
      await userEvent.click(submit);
      await waitFor(() => expect(posts).toEqual([{ site: "supplier" }]));
      // An authenticator site asks for its setup link, as a hidden field.
      const orders = screen.getByTestId("vault-browser-offer-orders");
      expect(orders).toHaveTextContent("Every change needs approval.");
      const link = within(orders).getByTestId("vault-browser-authenticator");
      expect(link).toHaveAttribute("type", "password");
      await userEvent.click(within(orders).getByTestId("vault-browser-confirm"));
      expect(within(orders).getByTestId("vault-browser-setup-submit")).toBeDisabled();
      await userEvent.type(link, "otpauth://totp/x?secret=ABC");
      await userEvent.click(within(orders).getByTestId("vault-browser-setup-submit"));
      await waitFor(() => expect(posts).toHaveLength(2));
      expect(posts[1]).toEqual({ site: "orders", authenticator: "otpauth://totp/x?secret=ABC" });
    });

    it("shows the site, its tier, the agent's address, and takes the login for that connection", async () => {
      const puts: unknown[] = [];
      const api = fakeApi({
        "GET /api/session": () => CLIENT_SESSION,
        "GET /api/overview": () => overview,
        "GET /api/access": () => ({
          items: [browserItem()],
          setup: [],
          canEdit: true,
          people: [],
        }),
        "PUT /api/connections/browser/credentials": ({ init }) => {
          puts.push(JSON.parse(String(init.body)));
          return { item: browserItem() };
        },
      });
      renderAt(api);
      const card = await screen.findByTestId("vault-item-browser-supplier");
      expect(within(card).getByTestId("vault-browser-tier")).toHaveTextContent("Low risk");
      expect(within(card).getByTestId("vault-browser-identity")).toHaveTextContent(
        "agent-abcdefghijkl@agents.mezonas.com",
      );
      expect(within(card).getByTestId("vault-browser-signins")).toHaveTextContent(
        "Sign-ins today: 2 of 10 · Site version 1",
      );
      await userEvent.click(within(card).getByTestId("vault-replace"));
      await userEvent.type(within(card).getByTestId("vault-field-username"), "agent@demo.test");
      await userEvent.type(within(card).getByTestId("vault-field-password"), "pw");
      await userEvent.click(within(card).getByTestId("vault-form-save"));
      await waitFor(() => expect(puts.length).toBe(1));
      expect(puts[0]).toEqual({
        values: { username: "agent@demo.test", password: "pw" },
        connectionId: BROWSER_CONN,
      });
    });

    it("shows and sets human release for a website login, as for other vault items", async () => {
      const puts: unknown[] = [];
      const on = {
        mode: "code",
        person: { id: "00000000-0000-4000-8000-0000000b0001", name: "Ana Ruiz" },
        channel: "email",
        window: { hours: 2 },
        sentTo: null,
        updatedAt: "2026-11-05T10:00:00.000Z",
        live: [],
      };
      const api = fakeApi({
        "GET /api/session": () => CLIENT_SESSION,
        "GET /api/overview": () => overview,
        "GET /api/access": () => ({
          items: [{ ...browserItem(), release: puts.length > 0 ? on : browserItem().release }],
          setup: [],
          canEdit: true,
          people: [
            {
              id: "00000000-0000-4000-8000-0000000b0001",
              name: "Ana Ruiz",
              email: "a•••@demo.example.com",
              canText: false,
            },
          ],
        }),
        [`PUT /api/access/connections/${BROWSER_CONN}/release`]: ({ init }) => {
          puts.push(JSON.parse(String(init.body)));
          return { item: { ...browserItem(), release: on } };
        },
      });
      renderAt(api);
      const card = await screen.findByTestId("vault-item-browser-supplier");
      const section = within(card).getByTestId("release-section");
      expect(section).toHaveTextContent("Off: agents use it without asking anyone first.");
      await userEvent.click(within(section).getByTestId("release-edit"));
      await userEvent.selectOptions(within(section).getByTestId("release-channel"), "email");
      await userEvent.selectOptions(within(section).getByTestId("release-window"), "2");
      await userEvent.click(within(section).getByTestId("release-save"));
      await waitFor(() => expect(puts).toHaveLength(1));
      expect(puts[0]).toMatchObject({ mode: "code", channel: "email", window: { hours: 2 } });
      await waitFor(() =>
        expect(within(card).getByTestId("release-summary")).toHaveTextContent(
          "Ana Ruiz releases it with a code by email, for 2 hours.",
        ),
      );
    });

    it("makes a login stricter; what is on stays on", async () => {
      const puts: unknown[] = [];
      const api = fakeApi({
        "GET /api/session": () => CLIENT_SESSION,
        "GET /api/overview": () => overview,
        "GET /api/access": () => ({
          items: [
            browserItem({
              stricter: { noWrites: true, personSignIn: false },
              stopped: { reason: "the site showed a CAPTCHA", at: "2026-11-05T10:00:00.000Z" },
            }),
          ],
          setup: [],
          canEdit: true,
          people: [],
        }),
        [`PUT /api/access/browser/${BROWSER_CONN}`]: ({ init }) => {
          puts.push(JSON.parse(String(init.body)));
          return { connectionId: BROWSER_CONN };
        },
      });
      renderAt(api);
      const card = await screen.findByTestId("vault-item-browser-supplier");
      expect(within(card).getByTestId("vault-browser-stopped")).toHaveTextContent(
        "the site showed a CAPTCHA",
      );
      await userEvent.click(within(card).getByTestId("vault-browser-stricter-open"));
      expect(within(card).getByTestId("vault-browser-noWrites")).toBeDisabled();
      await userEvent.click(within(card).getByTestId("vault-browser-personSignIn"));
      await userEvent.click(within(card).getByTestId("vault-browser-stricter-save"));
      await waitFor(() => expect(puts).toEqual([{ noWrites: true, personSignIn: true }]));
    });
  });
});
