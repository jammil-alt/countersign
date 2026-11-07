// C5 People (docs/ui-plan.md): the people table with relationship filters and one person's
// details (what agents should know, how they may reach them, the agents in touch); the client
// admin adds a person and makes a channel stricter (never looser); voice samples on their tab.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { CLIENT_SESSION, fakeApi, Reply } from "../../test/fixtures";

const TENANT = CLIENT_SESSION.activeTenantId as string;
const MARCO = "00000000-0000-4000-8000-0000000c0b01";
const LISA = "00000000-0000-4000-8000-0000000c0b02";
const AGENT = "00000000-0000-4000-8000-0000000a0b01";
const ME = "00000000-0000-4000-8000-0000000d0b01";

function contact(over: Record<string, unknown>) {
  return {
    id: MARCO,
    name: "Marco Díaz",
    phone: "+19725550188",
    whatsapp: null,
    email: "marco@rugby.example.com",
    language: null,
    preferredChannels: ["email", "sms"],
    notes: "Our main sheet goods vendor. Ask him before any order over $10,000.",
    organization: { id: "00000000-0000-4000-8000-0000000e0b01", name: "Rugby Architectural" },
    title: "Sales rep",
    relationship: "vendor",
    source: "manual",
    consent: {},
    optedOut: null,
    canMessage: { sms: true, whatsapp: false },
    canCall: false,
    canEmail: true,
    autonomy: { sms: "approval" },
    createdAt: "2026-11-05T10:00:00.000Z",
    updatedAt: "2026-11-05T10:00:00.000Z",
    ...over,
  };
}

const LISA_ROW = contact({
  id: LISA,
  name: "Lisa Park",
  email: "lisa@harbor.example.com",
  phone: null,
  title: "Bookkeeper",
  relationship: "employee",
  notes: "Signs bills up to $2,000.",
  organization: null,
  autonomy: {},
  canMessage: { sms: false, whatsapp: false },
});

function renderAt(
  path: string,
  role: "client_admin" | "client_user",
  routes: Record<string, Parameters<typeof fakeApi>[0][string]> = {},
) {
  const api = fakeApi({
    "GET /api/session": () => ({
      ...CLIENT_SESSION,
      tenants: [{ id: TENANT, name: "Harbor Millwork", role }],
    }),
    "GET /api/overview": () => new Reply(404, {}),
    "GET /api/feedback/status": () => ({ enabled: false }),
    "GET /api/directory": () => ({
      people: [contact({}), LISA_ROW],
      organizations: [],
      pendingSuggestions: 0,
    }),
    "GET /api/people": () => ({
      items: [
        {
          agentId: AGENT,
          agentName: "Pia",
          roles: [],
          people: { supplier: { contactIds: [MARCO], conditions: {} } },
          missing: [],
          contacts: [],
        },
      ],
    }),
    [`GET /api/contacts/${MARCO}/messages`]: () => ({
      items: [
        {
          id: "m1",
          direction: "out",
          channel: "email",
          text: "Asked for a new copy of quote Q-7781",
          sid: null,
          status: "sent",
          at: "2026-11-02T15:00:00.000Z",
        },
      ],
    }),
    ...routes,
  });
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
  return api;
}

describe("C5 People", () => {
  it("lists people by relationship and shows one person's details", async () => {
    renderAt("/people", "client_admin");
    expect(await screen.findByRole("heading", { name: "People", level: 1 })).toBeVisible();
    const marco = await screen.findByTestId(`people-row-${MARCO}`);
    expect(marco).toHaveTextContent("Rugby Architectural");
    expect(marco).toHaveTextContent("Email and Text");
    expect(screen.getByTestId("people-filter-all")).toHaveTextContent("All · 2");
    await userEvent.click(screen.getByTestId("people-filter-employee"));
    expect(screen.queryByTestId(`people-row-${MARCO}`)).toBeNull();
    expect(screen.getByTestId(`people-row-${LISA}`)).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("people-filter-all"));

    await userEvent.click(
      within(screen.getByTestId(`people-row-${MARCO}`)).getByText("Marco Díaz"),
    );
    const detail = await screen.findByTestId(`people-detail-${MARCO}`);
    expect(within(detail).getByTestId("people-detail-notes")).toHaveTextContent(
      "Ask him before any order over $10,000.",
    );
    expect(within(detail).getByTestId("people-reach-email-state")).toHaveTextContent(
      "No extra limit",
    );
    expect(within(detail).getByTestId("people-reach-sms-state")).toHaveTextContent("Your sign");
    // Calls: a number, but no consent to call yet.
    expect(within(detail).getByTestId("people-reach-voice-state")).toHaveTextContent(
      "No consent yet",
    );
    expect(detail).toHaveTextContent("Pia");
    expect(await within(detail).findByTestId("people-recent")).toHaveTextContent(
      "Asked for a new copy of quote Q-7781",
    );
  });

  // QA round 1: two tabs; the admin's four other pages behind one "More".
  it("shows People and Organizations as tabs, the admin's other pages under More", async () => {
    renderAt("/people", "client_admin");
    const tabs = await screen.findByRole("navigation", { name: "Sections" });
    expect(
      within(tabs)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["People", "Organizations"]);
    expect(screen.queryByTestId("people-import")).toBeNull();
    const more = screen.getByTestId("people-more");
    await userEvent.click(within(more).getByText("More"));
    expect(
      ["consent", "reach", "voice", "import"].map((id) =>
        within(more).getByTestId(`people-more-${id}`).getAttribute("href"),
      ),
    ).toEqual(["/people/contacts", "/people/reach", "/people/voice", "/people/import"]);
    await userEvent.click(within(more).getByTestId("people-more-voice"));
    // The page open from More also shows as a tab, current.
    await waitFor(() =>
      expect(
        within(screen.getByRole("navigation", { name: "Sections" })).getByRole("link", {
          name: "Voice samples",
        }),
      ).toHaveClass("border-slate"),
    );
  });

  it("gives a client user no More menu", async () => {
    renderAt("/people", "client_user");
    await screen.findByRole("navigation", { name: "Sections" });
    expect(screen.queryByTestId("people-more")).toBeNull();
  });

  it("makes a channel stricter for a person: never looser, the rest kept", async () => {
    const puts: unknown[] = [];
    renderAt(`/people?person=${MARCO}`, "client_admin", {
      [`PUT /api/contacts/${MARCO}/autonomy`]: ({ init }) => {
        puts.push(JSON.parse(String(init.body)));
        return { contact: contact({}) };
      },
    });
    const detail = await screen.findByTestId(`people-detail-${MARCO}`);
    await userEvent.click(within(detail).getByTestId("people-reach-tighten"));
    const sms = within(detail).getByTestId("people-reach-sms-level");
    expect(
      within(sms)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Your sign", "Off"]);
    const email = within(detail).getByTestId("people-reach-email-level");
    expect(
      within(email)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["No extra limit", "Your sign", "Off"]);
    await userEvent.selectOptions(email, "off");
    await userEvent.click(within(detail).getByTestId("people-reach-save"));
    await waitFor(() => expect(puts).toEqual([{ autonomy: { email: "off", sms: "approval" } }]));
  });

  it("adds a person from the header", async () => {
    const posts: unknown[] = [];
    renderAt("/people", "client_admin", {
      "POST /api/contacts": ({ init }) => {
        posts.push(JSON.parse(String(init.body)));
        return { contact: contact({ id: "00000000-0000-4000-8000-0000000c0b03", name: "Rosa" }) };
      },
    });
    await screen.findByTestId(`people-row-${MARCO}`);
    await userEvent.click(screen.getByTestId("people-add"));
    const form = await screen.findByTestId("people-add-form");
    await userEvent.type(within(form).getByTestId("directory-person-new-name"), "Rosa Gómez");
    await userEvent.type(
      within(form).getByTestId("directory-person-new-email"),
      "rosa@harbor.example.com",
    );
    await userEvent.click(within(form).getByTestId("directory-person-new-save"));
    await waitFor(() =>
      expect(posts).toEqual([{ name: "Rosa Gómez", email: "rosa@harbor.example.com" }]),
    );
  });

  it("a client user reads people, without the admin's columns or actions", async () => {
    const api = renderAt(`/people?person=${MARCO}`, "client_user");
    const detail = await screen.findByTestId(`people-detail-${MARCO}`);
    expect(within(detail).queryByTestId("people-reach-tighten")).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Agents in touch" })).toBeNull();
    expect(api.calls).not.toContain(`GET /api/contacts/${MARCO}/messages`);
  });

  it("adds a voice sample for one of your people", async () => {
    const posts: unknown[] = [];
    renderAt("/people/voice", "client_admin", {
      "GET /api/knowledge/voice-samples": () => ({ samples: [] }),
      "GET /api/users": () => ({
        users: [
          {
            userId: ME,
            email: "dana@harbor.example.com",
            name: "Dana Kim",
            role: "client_admin",
            signedIn: true,
          },
        ],
      }),
      "POST /api/knowledge/voice-samples": ({ init }) => {
        posts.push(JSON.parse(String(init.body)));
        return {
          sample: {
            id: "00000000-0000-4000-8000-0000000f0b01",
            status: "active",
            version: 1,
            title: "Order follow-up",
            text: "Hi Marco, any news on the birch?",
            channel: "email",
            person: { id: ME, name: "Dana Kim" },
            createdAt: "2026-11-05T10:00:00.000Z",
            updatedAt: "2026-11-05T10:00:00.000Z",
          },
        };
      },
    });
    expect(await screen.findByText("No voice samples yet.")).toBeVisible();
    await userEvent.click(screen.getByTestId("voice-add"));
    await screen.findByRole("option", { name: "Dana Kim" });
    await userEvent.selectOptions(screen.getByTestId("voice-person"), ME);
    await userEvent.type(screen.getByTestId("voice-title"), "Order follow-up");
    await userEvent.type(screen.getByTestId("voice-text"), "Hi Marco, any news on the birch?");
    await userEvent.click(screen.getByTestId("voice-save"));
    await waitFor(() =>
      expect(posts).toEqual([
        {
          title: "Order follow-up",
          text: "Hi Marco, any news on the birch?",
          channel: "email",
          personUserId: ME,
        },
      ]),
    );
  });
});
