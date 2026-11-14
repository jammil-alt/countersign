// `/ops/browser-sites`: the catalogue of websites agents may sign in to. Each site's tier with its
// meaning and notes; editing the profile saves a new version (checked with core's schema first);
// the tier is set with a note; a new site starts from a template.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION } from "../../test/fixtures";

const PROFILE = {
  login: {
    url: "https://portal.supplier.test/login",
    origins: ["https://portal.supplier.test"],
    usernameField: "#user",
    passwordField: "#pass",
    submitButton: "#go",
    secondFactor: {
      kind: "email",
      sender: "@supplier.test",
      pattern: "code is (\\d{6})",
      codeField: "#code",
      codeButton: "#verify",
    },
    signedIn: { selector: "#account" },
    stopSelectors: [],
  },
  signOut: { url: "https://portal.supplier.test/logout" },
  allow: ["https://portal.supplier.test/invoices*"],
  block: [],
  hosts: [],
  session: { keep: false },
  notes: "",
};

const site = (over: Record<string, unknown> = {}) => ({
  id: "00000000-0000-4000-8000-0000000b5001",
  slug: "supplier",
  name: "Supplier portal",
  tier: "low",
  notes: "Terms checked by J. M. on 2026-11-05",
  updatedAt: "2026-11-05T10:00:00.000Z",
  current: {
    id: "00000000-0000-4000-8000-0000000b5101",
    version: 1,
    profile: PROFILE,
    changeNote: null,
    createdAt: "2026-11-05T10:00:00.000Z",
  },
  versions: 1,
  connections: 2,
  ...over,
});

function renderAt(api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={["/ops/browser-sites"]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

describe("ops websites", () => {
  it("lists sites with the tier's meaning, notes and the always-blocked pages", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/browser-sites": () => ({ sites: [site()] }),
    });
    renderAt(api);
    const card = await screen.findByTestId("site-supplier");
    expect(within(card).getByTestId("site-tier")).toHaveTextContent("Low");
    expect(card).toHaveTextContent("Agents sign in on their own. Writes need approval by default");
    expect(card).toHaveTextContent("Terms checked by J. M. on 2026-11-05");
    expect(card).toHaveTextContent("version 1 of 1 · 2 client logins");
    expect(card).toHaveTextContent("https://portal.supplier.test");
    expect(screen.getByTestId("site-default-blocked")).toHaveTextContent("billing and payment");
  });

  it("counts the sites in each tier, with their client logins", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/browser-sites": () => ({
        sites: [
          site(),
          site({ slug: "bank", name: "Bank", tier: "blocked", connections: 0 }),
          site({ slug: "mill", name: "Mill portal", connections: 1 }),
        ],
      }),
    });
    renderAt(api);
    await screen.findByTestId("site-supplier");
    expect(screen.getByRole("heading", { name: "Websites" })).toBeInTheDocument();
    expect(screen.getByTestId("site-tier-count-low")).toHaveTextContent("2");
    expect(screen.getByTestId("site-tier-count-low")).toHaveTextContent("3 client logins");
    expect(screen.getByTestId("site-tier-count-medium")).toHaveTextContent("0");
    expect(screen.getByTestId("site-tier-count-blocked")).toHaveTextContent("Agents can't sign in");
  });

  it("saves an edited profile as a new version, and refuses one that doesn't parse", async () => {
    const posts: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/browser-sites": () => ({ sites: [site()] }),
      "POST /api/ops/browser-sites/supplier/versions": ({ init }) => {
        posts.push(JSON.parse(String(init.body)));
        return { site: site({ versions: 2 }) };
      },
    });
    renderAt(api);
    const card = await screen.findByTestId("site-supplier");
    await userEvent.click(within(card).getByTestId("site-edit"));
    const text = within(card).getByTestId("site-profile-text");
    // A login page off its origins is refused before anything is sent.
    const bad = { ...PROFILE, login: { ...PROFILE.login, url: "https://evil.test/login" } };
    fireEvent.change(text, { target: { value: JSON.stringify(bad) } });
    expect(within(card).getByTestId("site-profile-error")).toHaveTextContent("login.url");
    expect(within(card).getByTestId("site-save-version")).toBeDisabled();
    const good = {
      ...PROFILE,
      allow: [...PROFILE.allow, "https://portal.supplier.test/statements*"],
    };
    fireEvent.change(text, { target: { value: JSON.stringify(good) } });
    await userEvent.type(within(card).getByTestId("site-change-note"), "Statements too");
    await userEvent.click(within(card).getByTestId("site-save-version"));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({
      changeNote: "Statements too",
      profile: { allow: good.allow },
    });
  });

  it("sets the tier with a note", async () => {
    const puts: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/browser-sites": () => ({ sites: [site()] }),
      "PUT /api/ops/browser-sites/supplier/tier": ({ init }) => {
        puts.push(JSON.parse(String(init.body)));
        return { site: site({ tier: "blocked" }) };
      },
    });
    renderAt(api);
    const card = await screen.findByTestId("site-supplier");
    await userEvent.click(within(card).getByTestId("site-set-tier"));
    await userEvent.selectOptions(within(card).getByTestId("site-tier-select"), "blocked");
    expect(card).toHaveTextContent("Agents never sign in");
    const notes = within(card).getByTestId("site-notes");
    await userEvent.clear(notes);
    await userEvent.click(within(card).getByTestId("site-save-tier"));
    expect(puts).toEqual([]);
    await userEvent.type(notes, "Now takes payments");
    await userEvent.click(within(card).getByTestId("site-save-tier"));
    await waitFor(() => expect(puts).toEqual([{ tier: "blocked", notes: "Now takes payments" }]));
  });

  it("adds a site from the template", async () => {
    const posts: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/browser-sites": () => ({ sites: [] }),
      "POST /api/ops/browser-sites": ({ init }) => {
        posts.push(JSON.parse(String(init.body)));
        return { site: site() };
      },
    });
    renderAt(api);
    await userEvent.click(await screen.findByTestId("site-add"));
    const form = screen.getByTestId("site-new");
    expect(within(form).getByTestId("site-create")).toBeDisabled();
    await userEvent.type(within(form).getByTestId("site-slug"), "acme");
    await userEvent.type(within(form).getByTestId("site-name"), "Acme supply");
    await userEvent.type(within(form).getByTestId("site-notes"), "Terms checked by J. M.");
    await userEvent.click(within(form).getByTestId("site-create"));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({
      slug: "acme",
      name: "Acme supply",
      tier: "low",
      notes: "Terms checked by J. M.",
      profile: { login: { origins: ["https://portal.example.com"] } },
    });
  });
});
