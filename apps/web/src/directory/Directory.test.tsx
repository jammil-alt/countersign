// The directory (plan §1.27) on the portal's People page (C5): the people table with search, filters
// and one person's details; the client admin adds an organization and links it to its vendor record
// (Organizations), imports a CSV with a preview and accepts a suggestion (Import and suggestions);
// read-only for client users; the same panel on the back office's client page. In Spanish too.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../App";
import { CLIENT_SESSION, fakeApi, OPERATOR_SESSION, Reply } from "../test/fixtures";

const DEMO = "00000000-0000-4000-8000-00000000a002";
const PAT = "00000000-0000-4000-8000-0000000c0001";
const BIRCH = "00000000-0000-4000-8000-0000000e0001";
const SUGGESTION = "00000000-0000-4000-8000-0000000f0001";

function renderAt(path: string, api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

const pat = {
  id: PAT,
  name: "Pat Lee",
  phone: null,
  whatsapp: null,
  email: "pat@birch.example.com",
  language: null,
  organization: { id: BIRCH, name: "Birch & Co", language: "es" },
  languageUsed: { language: "es", from: "organization", organization: "Birch & Co" },
  title: "Sales rep",
  relationship: "vendor",
  source: "manual",
  consent: {},
  optedOut: null,
  canMessage: { sms: false, whatsapp: false },
  createdAt: "2026-11-05T10:00:00.000Z",
  updatedAt: "2026-11-05T10:00:00.000Z",
};

const birch = (over: Record<string, unknown> = {}) => ({
  id: BIRCH,
  name: "Birch & Co",
  kinds: ["vendor"],
  website: "https://birch.example.com",
  email: null,
  phone: null,
  address: null,
  language: "es",
  languageUsed: { language: "es", from: "person" },
  notes: null,
  externalRefs: {},
  vendor: null,
  source: "manual",
  people: 1,
  createdAt: "2026-11-05T10:00:00.000Z",
  updatedAt: "2026-11-05T10:00:00.000Z",
  ...over,
});

const portalBase = (session = CLIENT_SESSION) => ({
  "GET /api/session": () => session,
  "GET /api/feedback/status": () => ({ enabled: false }),
  "GET /api/overview": () => ({
    client: { id: DEMO, name: "Demo client" },
    services: [],
    needsYou: { inbox: 0 },
    recentRuns: [],
  }),
});

const suggestion = {
  id: SUGGESTION,
  change: {
    action: "update_person",
    contactId: PAT,
    changes: { email: "pat.lee@birch.example.com" },
  },
  reason: "Her last two invoices came from this address.",
  sources: [],
  target: { id: PAT, name: "Pat Lee" },
  diff: [{ field: "email", before: "pat@birch.example.com", after: "pat.lee@birch.example.com" }],
  changesAddress: true,
  agent: { id: "a1", name: "Records clerk" },
  status: "open",
  createdAt: "2026-11-05T10:00:00.000Z",
};

describe("portal directory", () => {
  it("searches people, then adds an organization and links it to its vendor record", async () => {
    const orgs = [birch()];
    const queries: string[] = [];
    const sent: unknown[] = [];
    const api = fakeApi({
      ...portalBase(),
      "GET /api/directory": ({ url }) => {
        queries.push(url.search);
        return { people: [pat], organizations: orgs, pendingSuggestions: 1 };
      },
      "POST /api/directory/organizations": ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        const o = birch({
          id: "00000000-0000-4000-8000-0000000e0002",
          name: "Oak Mill",
          people: 0,
        });
        orgs.push(o);
        return { organization: o };
      },
      [`POST /api/directory/organizations/${BIRCH}/vendor`]: () => {
        orgs[0] = birch({ vendor: { id: "v1", name: "Birch & Co" } });
        return { organization: orgs[0] };
      },
    });
    // `/directory` was the directory's page: Contacts is its home now.
    renderAt("/directory", api);
    const row = await screen.findByTestId(`people-row-${PAT}`);
    expect(row).toHaveTextContent("Birch & Co");
    expect(within(row).getByText("Vendor")).toBeInTheDocument();
    expect(row).toHaveTextContent("Sales rep");
    await userEvent.click(within(row).getByTestId(`people-open-${PAT}`));
    const detail = await screen.findByTestId(`people-detail-${PAT}`);
    expect(detail).toHaveTextContent("Sales rep · Birch & Co");
    // Pat has no language of their own: Birch's is used, and the details say so.
    expect(detail).toHaveTextContent("Uses: Spanish (from Birch & Co)");

    await userEvent.type(screen.getByTestId("people-search"), "birch");
    await waitFor(() => expect(queries.at(-1)).toContain("q=birch"));
    await userEvent.click(await screen.findByTestId("people-filter-vendor"));
    expect(screen.getByTestId("people-filter-vendor")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId(`people-row-${PAT}`)).toBeInTheDocument();

    // Organizations are a filter of the list.
    await userEvent.click(screen.getByTestId("people-filter-organizations"));
    await userEvent.type(screen.getByTestId("directory-org-new-name"), "Oak Mill");
    await userEvent.click(screen.getByTestId("directory-org-new-kind-vendor"));
    await userEvent.selectOptions(screen.getByTestId("directory-org-new-language"), "fr");
    await userEvent.click(screen.getByTestId("directory-org-new-save"));
    await waitFor(() =>
      expect(sent).toEqual([{ name: "Oak Mill", kinds: ["vendor"], language: "fr" }]),
    );

    await userEvent.click(await screen.findByTestId(`directory-org-${BIRCH}-link`));
    expect(await screen.findByTestId(`directory-org-${BIRCH}-vendor`)).toHaveTextContent(
      "Vendor record: Birch & Co",
    );
  });

  it("asks once when typing stops, and dims the last rows until the answer comes", async () => {
    const queries: string[] = [];
    const answers: (() => void)[] = [];
    const api = fakeApi({
      ...portalBase(),
      "GET /api/directory": ({ url }) => {
        queries.push(url.search);
        const body = { people: [pat], organizations: [], pendingSuggestions: 0 };
        if (!url.searchParams.get("q")) return body;
        return new Promise((resolve) => {
          answers.push(() => resolve(body));
        });
      },
    });
    renderAt("/contacts", api);
    await screen.findByTestId(`people-row-${PAT}`);
    await userEvent.type(screen.getByTestId("people-search"), "birch");
    await waitFor(() => expect(queries.filter((q) => q.includes("q="))).toEqual(["?q=birch"]));
    // The last answer's rows stay, dimmed and busy, while the search's answer loads.
    expect(screen.getByTestId(`people-row-${PAT}`)).toBeInTheDocument();
    expect(screen.getByTestId("people-list")).toHaveAttribute("aria-busy", "true");
    for (const answer of answers) answer();
    await waitFor(() =>
      expect(screen.getByTestId("people-list")).toHaveAttribute("aria-busy", "false"),
    );
    expect(queries.filter((q) => q.includes("q="))).toEqual(["?q=birch"]);
  });

  it("keeps the last rows dimmed, with the error beside them, when a search fails", async () => {
    const api = fakeApi({
      ...portalBase(),
      "GET /api/directory": ({ url }) =>
        url.searchParams.get("q")
          ? new Reply(500, { error: "internal" })
          : { people: [pat], organizations: [], pendingSuggestions: 0 },
    });
    renderAt("/contacts", api);
    await screen.findByTestId(`people-row-${PAT}`);
    await userEvent.type(screen.getByTestId("people-search"), "oak");
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByTestId(`people-row-${PAT}`)).toBeInTheDocument();
    expect(screen.getByTestId("people-list")).toHaveAttribute("aria-busy", "true");
  });

  it("previews a CSV and applies the chosen rows, with a result per row", async () => {
    const applied: unknown[] = [];
    const api = fakeApi({
      ...portalBase(),
      "GET /api/directory": () => ({ people: [], organizations: [], pendingSuggestions: 0 }),
      "GET /api/directory/import/sources": () => ({ sources: [] }),
      "POST /api/directory/import/csv": () => ({
        kind: "people",
        source: "csv",
        more: false,
        counts: { add: 1, update: 0, same: 0, error: 1 },
        rows: [
          {
            row: 1,
            action: "add",
            data: { name: "Dana Cruz", email: "dana@oak.example.com" },
            match: null,
            changes: [{ field: "email", before: null, after: "dana@oak.example.com" }],
            changesAddress: false,
            problems: [],
          },
          {
            row: 2,
            action: "error",
            data: null,
            match: null,
            changes: [],
            changesAddress: false,
            problems: ["name: Too small"],
          },
        ],
      }),
      "POST /api/directory/import/apply": ({ init }) => {
        applied.push(JSON.parse(String(init.body)));
        return {
          results: [
            { row: 1, status: "added", id: PAT, name: "Dana Cruz", problem: null },
            { row: 2, status: "skipped", id: null, name: null, problem: null },
          ],
          counts: { added: 1, updated: 0, unchanged: 0, skipped: 1, failed: 0 },
        };
      },
    });
    renderAt("/people/import", api);
    await userEvent.click(await screen.findByTestId("directory-tab-import"));
    expect(await screen.findByText("Connect Zoho CRM or Podio to import from them.")).toBeVisible();
    const file = new File(["Name,Email\nDana Cruz,dana@oak.example.com\n,\n"], "people.csv", {
      type: "text/csv",
    });
    await userEvent.upload(screen.getByTestId("directory-import-file"), file);
    const preview = await screen.findByTestId("directory-import-preview");
    expect(
      within(preview).getByText("1 to add, 0 to update, 0 unchanged, 1 with problems"),
    ).toBeVisible();
    expect(
      within(screen.getByTestId("directory-import-row-2")).getByText("name: Too small"),
    ).toBeVisible();
    await userEvent.click(screen.getByTestId("directory-import-apply"));
    await waitFor(() =>
      expect(applied).toEqual([
        {
          source: "csv",
          kind: "people",
          csv: "Name,Email\nDana Cruz,dana@oak.example.com\n,\n",
          rows: [1],
        },
      ]),
    );
    expect(await screen.findByTestId("directory-import-result")).toHaveTextContent(
      "Done: 1 added, 0 updated, 0 failed",
    );
  });

  it("shows a suggestion that changes an email, and accepts it", async () => {
    const decided: unknown[] = [];
    let items = [suggestion];
    const api = fakeApi({
      ...portalBase(),
      "GET /api/directory": () => ({
        people: [pat],
        organizations: [],
        pendingSuggestions: items.length,
      }),
      "GET /api/directory/suggestions": () => ({ items }),
      [`POST /api/directory/suggestions/${SUGGESTION}`]: ({ init }) => {
        decided.push(JSON.parse(String(init.body)));
        items = [];
        return { suggestion: { ...suggestion, status: "accepted" } };
      },
    });
    renderAt("/people/import", api);
    await userEvent.click(await screen.findByTestId("directory-tab-suggestions"));
    const card = await screen.findByTestId(`directory-suggestion-${SUGGESTION}`);
    expect(within(card).getByText("Records clerk suggests")).toBeVisible();
    expect(within(card).getByText("Update Pat Lee")).toBeVisible();
    expect(
      within(card).getByText("pat@birch.example.com → pat.lee@birch.example.com"),
    ).toBeVisible();
    expect(screen.getByTestId(`directory-suggestion-${SUGGESTION}-address`)).toHaveTextContent(
      "Changes how messages reach them",
    );
    await userEvent.click(screen.getByTestId(`directory-suggestion-${SUGGESTION}-accept`));
    await waitFor(() => expect(decided).toEqual([{ decision: "approve" }]));
    expect(await screen.findByText("No suggestions waiting.")).toBeVisible();
  });

  it("client users read it, with no editing, import or suggestions", async () => {
    const userSession = {
      ...CLIENT_SESSION,
      tenants: [{ id: DEMO, name: "Demo client", role: "client_user" as const }],
    };
    const api = fakeApi({
      ...portalBase(userSession),
      "GET /api/directory": () => ({
        people: [pat],
        organizations: [birch()],
        pendingSuggestions: 0,
      }),
    });
    renderAt("/people", api);
    const row = await screen.findByTestId(`people-row-${PAT}`);
    await userEvent.click(within(row).getByTestId(`people-open-${PAT}`));
    await screen.findByTestId(`people-detail-${PAT}`);
    expect(screen.queryByTestId("people-detail-edit")).toBeNull();
    expect(screen.queryByTestId("people-reach-tighten")).toBeNull();
    expect(screen.queryByTestId("people-add")).toBeNull();
    expect(screen.queryByTestId("people-import")).toBeNull();
    // The people and the organizations (a filter), nothing an admin keeps.
    expect(screen.getByTestId("people-filter-organizations")).toHaveTextContent(
      "Organizations · 1",
    );
    await userEvent.click(screen.getByTestId("people-filter-organizations"));
    expect(await screen.findByTestId(`directory-org-${BIRCH}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`directory-org-${BIRCH}-edit`)).toBeNull();
    // Who agents reach is the client admin's: not even asked for.
    expect(api.calls).not.toContain("GET /api/people");
  });

  it("speaks the client's language", async () => {
    const api = fakeApi({
      ...portalBase({ ...CLIENT_SESSION, language: { effective: "es", user: "es", client: null } }),
      "GET /api/directory": () => ({ people: [pat], organizations: [], pendingSuggestions: 0 }),
    });
    renderAt("/people", api);
    expect(await screen.findByRole("heading", { name: "Contactos", level: 1 })).toBeVisible();
    const row = await screen.findByTestId(`people-row-${PAT}`);
    expect(screen.getByTestId("people-filter-organizations")).toHaveTextContent("Organizaciones");
    expect(within(row).getByText("Proveedor")).toBeVisible();
    await userEvent.click(within(row).getByTestId(`people-open-${PAT}`));
    expect(await screen.findByTestId(`people-detail-${PAT}`)).toHaveTextContent(
      "Usa: español (de Birch & Co)",
    );
  });
});

describe("back office directory", () => {
  it("shows the client's directory on the client page, editable by the operator", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${DEMO}`]: () => ({
        client: { id: DEMO, name: "Demo client", timezone: "America/Chicago" },
        agents: [],
      }),
      [`GET /api/ops/clients/${DEMO}/directory`]: () => ({
        people: [pat],
        organizations: [birch()],
        pendingSuggestions: 0,
      }),
    });
    renderAt(`/ops/clients/${DEMO}/directory`, api);
    expect(await screen.findByTestId(`directory-person-${PAT}`)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Directory" })).toBeInTheDocument();
    expect(screen.getByTestId(`directory-person-${PAT}-edit`)).toBeInTheDocument();
    expect(screen.getByTestId("directory-tab-import")).toBeInTheDocument();
  });

  it("searches the client's directory once typing stops", async () => {
    const queries: string[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${DEMO}`]: () => ({
        client: { id: DEMO, name: "Demo client", timezone: "America/Chicago" },
        agents: [],
      }),
      [`GET /api/ops/clients/${DEMO}/directory`]: ({ url }) => {
        queries.push(url.search);
        return { people: [pat], organizations: [birch()], pendingSuggestions: 0 };
      },
    });
    renderAt(`/ops/clients/${DEMO}/directory`, api);
    expect(await screen.findByTestId(`directory-person-${PAT}`)).toBeInTheDocument();
    await userEvent.type(screen.getByTestId("directory-search"), "pat");
    await waitFor(() => expect(queries.filter((q) => q.includes("q="))).toEqual(["?q=pat"]));
    expect(screen.getByTestId(`directory-person-${PAT}`)).toBeInTheDocument();
  });

  it("invites one of the client's own people to sign in, with a status on each person", async () => {
    const SAM = "00000000-0000-4000-8000-0000000c0002";
    const ROW = "00000000-0000-4000-8000-0000000c0003";
    const NOEMAIL = "00000000-0000-4000-8000-0000000c0004";
    const sam = {
      ...pat,
      id: SAM,
      name: "Sam Ortiz",
      email: "sam@demo.example.com",
      organization: null,
      relationship: "employee",
      access: null,
    };
    const row = {
      ...sam,
      id: ROW,
      name: "Row Member",
      email: "row@demo.example.com",
      access: "member",
    };
    const noEmail = { ...sam, id: NOEMAIL, name: "No Email", email: null, access: null };
    const posts: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${DEMO}`]: () => ({
        client: { id: DEMO, name: "Demo client", timezone: "America/Chicago" },
        agents: [],
      }),
      [`GET /api/ops/clients/${DEMO}/directory`]: () => ({
        people: [
          { ...pat, access: null },
          posts.length > 0 ? { ...sam, access: "invited" } : sam,
          row,
          noEmail,
        ],
        organizations: [birch()],
        pendingSuggestions: 0,
      }),
      [`POST /api/ops/clients/${DEMO}/contacts/${SAM}/invite`]: ({ init }) => {
        posts.push(JSON.parse(String(init.body)));
        return {
          member: {
            userId: "u-sam",
            email: "sam@demo.example.com",
            name: "Sam Ortiz",
            role: "client_admin",
            signedIn: false,
            canSign: true,
          },
          email: { status: "sent", reason: null },
        };
      },
    });
    renderAt(`/ops/clients/${DEMO}/directory`, api);
    await screen.findByTestId(`directory-person-${SAM}`);
    // A vendor and a member get no button; an employee with no email gets a quiet hint.
    expect(screen.queryByTestId(`directory-person-${PAT}-invite`)).toBeNull();
    expect(screen.queryByTestId(`directory-person-${ROW}-invite`)).toBeNull();
    expect(screen.getByTestId(`directory-person-${ROW}-access`)).toHaveTextContent("Can sign in");
    expect(screen.queryByTestId(`directory-person-${NOEMAIL}-invite`)).toBeNull();
    expect(screen.getByTestId(`directory-person-${NOEMAIL}-invite-no-email`)).toHaveTextContent(
      "Add an email to invite",
    );

    await userEvent.click(screen.getByTestId(`directory-person-${SAM}-invite`));
    const dialog = await screen.findByRole("dialog", { name: "Invite to sign in" });
    expect(
      within(dialog).getByTestId(`directory-person-${SAM}-invite-dialog-email`),
    ).toHaveTextContent("sam@demo.example.com");
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    await userEvent.selectOptions(
      within(dialog).getByTestId(`directory-person-${SAM}-invite-dialog-role`),
      "client_admin",
    );
    // A client admin always approves.
    expect(
      within(dialog).getByTestId(`directory-person-${SAM}-invite-dialog-can-sign`),
    ).toBeDisabled();
    await userEvent.click(within(dialog).getByTestId(`directory-person-${SAM}-invite-dialog-send`));
    expect(
      await within(dialog).findByTestId(`directory-person-${SAM}-invite-dialog-done`),
    ).toHaveTextContent("We emailed sam@demo.example.com an invitation.");
    expect(posts).toEqual([{ role: "client_admin", canSign: true }]);
    await userEvent.click(
      within(dialog).getByTestId(`directory-person-${SAM}-invite-dialog-close`),
    );
    expect(await screen.findByTestId(`directory-person-${SAM}-access`)).toHaveTextContent(
      "Invited, hasn't signed in yet",
    );
    expect(screen.queryByTestId(`directory-person-${SAM}-invite`)).toBeNull();
  });
});
