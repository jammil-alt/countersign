// Scripts on website logins (docs/plan.md §1.86 "Scripts (wave 4)"): the portal's Accounts page
// shows the client admin where each script stands and records one action at a time (the page and
// its screenshot come back; a submit is recorded, never clicked), in the client's language; the
// back office's Websites screen lists every client's scripts, tests a version and publishes it;
// a script-draft offer in the Escalations opens the recorder with its path.
import { BrowserScriptDefinition } from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../App";
import { createTranslator } from "../i18n/catalog";
import { VersionSteps } from "../ops/screens/BrowserScripts";
import { CLIENT_SESSION, fakeApi, OPERATOR_SESSION } from "../test/fixtures";
import { problemWords } from "./scripts";

const DEMO = CLIENT_SESSION.activeTenantId as string;
const LOGIN = "00000000-0000-4000-8000-0000000c0001";
const SCRIPT = "00000000-0000-4000-8000-0000000d0001";
const OFFER = "00000000-0000-4000-8000-0000000e0001";

const overview = {
  client: { id: DEMO, name: "Demo client" },
  services: [],
  needsYou: { inbox: 0 },
  recentRuns: [],
};

const recording = (over: Record<string, unknown> = {}) => ({
  description: "",
  inputs: [],
  outputs: [],
  steps: [],
  evidence: {},
  undo: { kind: "none" },
  ...over,
});

const script = (over: Record<string, unknown> = {}) => ({
  id: SCRIPT,
  clientId: DEMO,
  clientName: "Demo client",
  connectionId: LOGIN,
  site: "supplier",
  siteName: "Supplier portal",
  slug: "place-order",
  name: "Place an order",
  state: "recording",
  createdSide: "client",
  recording: recording(),
  problems: [{ code: "empty", params: {}, text: "nothing is recorded yet" }],
  recordingDiffers: false,
  versions: [],
  published: null,
  offerItemId: null,
  updatedAt: "2026-11-10T10:00:00.000Z",
  ...over,
});

/** A write version as stored: fixed text, an input, a read, a plain click and the submit. */
const ORDER_DEFINITION = {
  schemaVersion: 1,
  site: "supplier",
  name: "Place an order",
  description: "",
  inputs: [{ name: "qty", label: "Quantity", type: "text" }],
  outputs: [{ name: "price", label: "Unit price", type: "decimal" }],
  steps: [
    { id: "s1", op: "open", url: "https://portal.supplier.test/orders/new" },
    { id: "s2", op: "fill", selector: "#sku", value: { text: "OAK-1" } },
    { id: "s3", op: "fill", selector: "#qty", value: { input: "qty" } },
    { id: "s4", op: "read_field", selector: "#price", output: "price" },
    { id: "s5", op: "click", selector: "#details", submits: false },
    { id: "s6", op: "click", selector: "#place", submits: true },
  ],
  sideEffect: "external",
  undo: { kind: "reverse", script: "cancel-order", inputs: { order: { output: "price" } } },
};

const login = {
  clientId: DEMO,
  clientName: "Demo client",
  connectionId: LOGIN,
  site: "supplier",
  siteName: "Supplier portal",
  tier: "low",
};

const page = (over: Record<string, unknown> = {}) => ({
  url: "https://portal.supplier.test/orders/new",
  text: "New order",
  tables: [],
  controls: [
    { selector: "#sku", kind: "field", label: "SKU" },
    { selector: "#place", kind: "button", label: "Place order" },
  ],
  screenshotUrl: "https://app.test/api/files/shot.png",
  screenshotWithheld: false,
  ...over,
});

function renderAt(path: string, api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

function portalApi(routes: Parameters<typeof fakeApi>[0], session = CLIENT_SESSION) {
  return fakeApi({
    "GET /api/session": () => session,
    "GET /api/overview": () => overview,
    "GET /api/access": () => ({ items: [], setup: [], canEdit: true, people: [] }),
    ...routes,
  });
}

describe("scripts in the portal", () => {
  it("shows the client admin where each script stands", async () => {
    const api = portalApi({
      "GET /api/access/browser-scripts": () => ({
        scripts: [
          script({
            state: "draft",
            versions: [
              {
                version: 1,
                sideEffect: "external",
                recordedSide: "client",
                createdAt: "2026-11-10T10:00:00.000Z",
              },
            ],
          }),
          script({
            id: "00000000-0000-4000-8000-0000000d0002",
            slug: "check-stock",
            name: "Check stock",
            state: "published",
            published: { version: 2, publishedAt: "2026-11-10T11:00:00.000Z" },
          }),
        ],
        logins: [login],
      }),
    });
    renderAt("/accounts", api);
    const card = await screen.findByTestId("portal-scripts");
    expect(within(card).getByTestId("script-row-place-order")).toHaveTextContent(
      "Waiting for us to publish",
    );
    expect(within(card).getByTestId("script-row-check-stock")).toHaveTextContent("Published · v2");
    // We publish: the portal never offers it.
    expect(within(card).queryByTestId("script-publish")).toBeNull();
  });

  it("records an action and shows the page after it, then marks the submit without clicking it", async () => {
    let current = script();
    const sent: unknown[] = [];
    const api = portalApi({
      "GET /api/access/browser-scripts": () => ({ scripts: [current], logins: [login] }),
      "POST /api/access/browser-scripts": ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        return { script: current };
      },
      [`POST /api/access/browser-scripts/${SCRIPT}/actions`]: ({ init }) => {
        const body = JSON.parse(String(init.body));
        sent.push(body);
        const step =
          body.action.op === "open"
            ? { id: "s1", op: "open", url: "https://portal.supplier.test/orders/new" }
            : { id: "s2", op: "click", selector: "#place", submits: true };
        current = script({ recording: recording({ steps: [...current.recording.steps, step] }) });
        return { script: current, step, page: page() };
      },
    });
    renderAt("/accounts", api);
    const card = await screen.findByTestId("portal-scripts");
    await userEvent.click(within(card).getByTestId("portal-scripts-record"));
    await userEvent.type(within(card).getByTestId("script-start-name"), "Place an order");
    await userEvent.click(within(card).getByTestId("script-start-go"));
    await waitFor(() =>
      expect(sent[0]).toEqual({
        connectionId: LOGIN,
        slug: "place-an-order",
        name: "Place an order",
      }),
    );

    const recorder = await screen.findByTestId("script-place-order");
    expect(within(recorder).getByTestId("script-steps")).toHaveTextContent("Nothing recorded yet");
    await userEvent.type(within(recorder).getByTestId("script-action-url"), "/orders/new");
    await userEvent.click(within(recorder).getByTestId("script-action-do"));
    await waitFor(() =>
      expect(within(recorder).getByTestId("script-step-s1")).toHaveTextContent(
        "Open https://portal.supplier.test/orders/new",
      ),
    );
    expect(within(recorder).getByTestId("script-screenshot")).toHaveAttribute(
      "src",
      "https://app.test/api/files/shot.png",
    );
    // A control on the page fills the selector.
    await userEvent.selectOptions(within(recorder).getByTestId("script-action-op"), "click");
    await userEvent.click(within(recorder).getByTitle("#place"));
    expect(within(recorder).getByTestId("script-action-selector")).toHaveValue("#place");
    await userEvent.click(within(recorder).getByTestId("script-action-submits"));
    await userEvent.click(within(recorder).getByTestId("script-action-do"));
    await waitFor(() =>
      expect(within(recorder).getByTestId("script-step-s2")).toHaveTextContent(
        "Send the form with #place",
      ),
    );
    expect(sent.at(-1)).toEqual({ action: { op: "click", selector: "#place", submits: true } });
    // Nothing is recorded after the submit.
    expect(within(recorder).queryByTestId("script-action")).toBeNull();
  });

  it("reads in the client's language", async () => {
    const api = portalApi(
      {
        "GET /api/access/browser-scripts": () => ({
          scripts: [script({ state: "draft" })],
          logins: [login],
        }),
      },
      { ...CLIENT_SESSION, language: { effective: "de", user: "de", client: null } },
    );
    renderAt("/accounts", api);
    const card = await screen.findByTestId("portal-scripts");
    expect(card).toHaveTextContent("Skripte");
    expect(within(card).getByTestId("script-row-place-order")).toHaveTextContent(
      "Wartet auf unsere Veröffentlichung",
    );
  });
});

describe("where a script stands, and what stops it, in the client's words", () => {
  it("says an older version runs while a newer one waits for us", async () => {
    const version = (n: number) => ({
      version: n,
      sideEffect: "none",
      recordedSide: "client",
      createdAt: "2026-11-10T10:00:00.000Z",
    });
    const api = portalApi(
      {
        "GET /api/access/browser-scripts": () => ({
          scripts: [
            script({
              state: "draft",
              versions: [version(1), version(2)],
              published: { version: 1, publishedAt: "2026-11-10T11:00:00.000Z" },
            }),
          ],
          logins: [login],
        }),
      },
      { ...CLIENT_SESSION, language: { effective: "fr", user: "fr", client: null } },
    );
    renderAt("/accounts", api);
    const card = await screen.findByTestId("portal-scripts");
    expect(within(card).getByTestId("script-row-place-order")).toHaveTextContent(
      "Publié · v1, v2 en attente de notre publication",
    );
  });

  it("translates a problem with a code, and keeps the server's words otherwise", () => {
    const de = createTranslator("de");
    expect(
      problemWords(
        {
          code: "unknown_input",
          params: { step: "s2", name: "sku" },
          text: "step s2 uses sku, which isn't an input",
        },
        de,
      ),
    ).toBe("Schritt s2 verwendet sku, das keine Eingabe ist");
    expect(problemWords("nothing is recorded yet", de)).toBe("nothing is recorded yet");
    expect(problemWords({ code: "something_new", text: "a new problem" }, de)).toBe(
      "a new problem",
    );
    // A name the server didn't send: its own words, never a sentence with a gap.
    expect(
      problemWords({ code: "unused_input", params: {}, text: "no step uses the input note" }, de),
    ).toBe("no step uses the input note");
    for (const locale of ["en", "es", "fr", "it", "pt-BR", "de"] as const) {
      expect(
        problemWords({ code: "submit_not_last", text: "x" }, createTranslator(locale)),
      ).not.toBe("x");
    }
  });
});

describe("scripts in the back office", () => {
  // The back office's versions carry their stored definitions (the portal's never do).
  const draft = script({
    state: "draft",
    problems: [],
    recording: recording({
      steps: [{ id: "s1", op: "open", url: "https://portal.supplier.test/orders/new" }],
    }),
    versions: [
      {
        version: 1,
        sideEffect: "external",
        recordedSide: "client",
        createdAt: "2026-11-10T10:00:00.000Z",
        definition: ORDER_DEFINITION,
      },
    ],
  });

  it("lists every client's scripts, tests a version as a dry run and publishes it", async () => {
    let current: Record<string, unknown> = { ...draft, recordingDiffers: true };
    const calls: string[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/browser-sites": () => ({ sites: [] }),
      "GET /api/ops/browser-scripts": () => ({ scripts: [current], logins: [login] }),
      [`POST /api/ops/browser-scripts/${SCRIPT}/test`]: ({ init }) => {
        calls.push(`test ${String(init.body)}`);
        return {
          outcome: "done",
          dryRun: true,
          screenshotWithheld: false,
          outputs: { price: "1212.50", submitted: false, url: null },
          reason: null,
          steps: [
            {
              id: "s1",
              op: "open",
              url: "https://portal.supplier.test/orders/new",
              status: "done",
              screenshotUrl: null,
            },
          ],
          needsHelp: null,
        };
      },
      [`POST /api/ops/browser-scripts/${SCRIPT}/versions/1/publish`]: () => {
        calls.push("publish");
        current = {
          ...draft,
          state: "published",
          published: { version: 1, publishedAt: "2026-11-10T12:00:00.000Z" },
        };
        return { script: current };
      },
    });
    renderAt("/ops/library/browser-sites", api);
    const row = await screen.findByTestId("script-row-place-order");
    expect(row).toHaveTextContent("Demo client · Supplier portal");
    expect(row).toHaveTextContent("Waiting for us to publish");
    await userEvent.click(within(row).getByTestId("script-row-place-order-open"));
    const recorder = await screen.findByTestId("script-place-order");
    await userEvent.click(within(recorder).getByTestId("script-test"));
    const result = await within(recorder).findByTestId("script-test-result");
    expect(result).toHaveTextContent("Test passed · nothing was submitted");
    expect(calls[0]).toBe('test {"version":1}');
    // With the version's stored steps on screen, Publish is on.
    const steps = within(recorder).getByTestId("script-version-steps");
    expect(within(recorder).queryByTestId("script-version-unseen")).toBeNull();
    expect(within(recorder).getByTestId("script-publish")).toBeEnabled();
    expect(steps).toHaveTextContent("the fixed text “OAK-1”");
    expect(within(recorder).getByTestId("script-version-submit-s6")).toHaveTextContent(
      "Sends the form",
    );
    expect(within(recorder).getByTestId("script-recording-differs")).toHaveTextContent(
      "Not saved yet",
    );
    await userEvent.click(within(recorder).getByTestId("script-publish"));
    await waitFor(() => expect(calls).toContain("publish"));
    await waitFor(() =>
      expect(screen.getByTestId("script-row-place-order")).toHaveTextContent("Published · v1"),
    );
  });

  it("shows the exact steps of the version it publishes", () => {
    render(
      <VersionSteps version={2} definition={BrowserScriptDefinition.parse(ORDER_DEFINITION)} />,
    );
    const steps = screen.getByTestId("script-version-steps");
    expect(steps).toHaveTextContent("Version 2 · what publishing sends");
    expect(screen.getByTestId("script-version-effect")).toHaveTextContent(
      "Sends a form on the site: a write, approved by a person every time. Undone by the script cancel-order with order from the output price.",
    );
    expect(steps).toHaveTextContent("qty (Quantity, text)");
    expect(steps).toHaveTextContent("price (Unit price, decimal)");
    expect(screen.getByTestId("script-version-step-s1")).toHaveTextContent(
      "Open https://portal.supplier.test/orders/new",
    );
    expect(screen.getByTestId("script-version-step-s2")).toHaveTextContent(
      "#sku with the fixed text “OAK-1”",
    );
    expect(screen.getByTestId("script-version-step-s4")).toHaveTextContent(
      "#price as the output price",
    );
    expect(screen.getByTestId("script-version-step-s5")).toHaveTextContent(
      "#details doesn't send anything",
    );
    expect(screen.getByTestId("script-version-step-s3")).toHaveTextContent(
      "#qty with the input qty",
    );
    expect(screen.getByTestId("script-version-step-s6")).toHaveTextContent(
      "#place Sends the form · the write",
    );
  });

  it("starts a recording from a script-draft offer with its path", async () => {
    const sent: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/browser-sites": () => ({ sites: [] }),
      "GET /api/ops/browser-scripts": () => ({ scripts: [], logins: [login] }),
      "POST /api/ops/browser-scripts": ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        return { script: draft };
      },
    });
    renderAt(`/ops/library/browser-sites?offer=${OFFER}&client=${DEMO}`, api);
    const start = await screen.findByTestId("script-start");
    expect(within(start).getByTestId("script-start-login")).toHaveValue(LOGIN);
    await userEvent.type(within(start).getByTestId("script-start-name"), "Find invoices");
    await userEvent.click(within(start).getByTestId("script-start-go"));
    await waitFor(() =>
      expect(sent[0]).toEqual({
        connectionId: LOGIN,
        slug: "find-invoices",
        name: "Find invoices",
        fromOffer: OFFER,
      }),
    );
  });
});
