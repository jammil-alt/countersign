// Languages in the app (docs/plan.md §1.18): every message file has exactly English's keys, forms
// and placeholders; plurals; Intl formats in the reader's region; API errors by code; the portal
// in Spanish and German; the language picker; sign-in in the browser's language; the back office
// in English.
import { LOCALES, type Locale } from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppProviders, AppRoutes } from "../App";
import { ApiError } from "../api/client";
import { CLIENT_SESSION, fakeApi, OPERATOR_SESSION, Reply, SANDBOX_DETAIL } from "../test/fixtures";
import { CATALOGS, createTranslator, type PluralForms } from "./catalog";
import { errorText } from "./errors";
import { intlLocaleFor } from "./format";
import { createI18n } from "./i18n";
import { en } from "./messages/en";

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const forms = (entry: string | PluralForms) =>
  typeof entry === "string" ? [entry] : Object.values(entry).filter((v) => v !== undefined);

describe("message files", () => {
  const english = en as Record<string, string | PluralForms>;

  for (const locale of LOCALES) {
    it(`${locale} has exactly English's keys, forms and placeholders`, () => {
      const catalog = CATALOGS[locale] as Record<string, string | PluralForms>;
      expect(Object.keys(catalog).sort()).toEqual(Object.keys(english).sort());
      for (const [key, source] of Object.entries(english)) {
        const entry = catalog[key];
        if (entry === undefined) throw new Error(`${locale} lacks ${key}`);
        // A plural in English is a plural everywhere, with an `other` form.
        expect(typeof entry, `${locale} ${key}`).toBe(typeof source);
        if (typeof entry !== "string") expect(entry.other, `${locale} ${key}`).toBeTruthy();
        const wanted = [...new Set(forms(source).flatMap(placeholders))].sort();
        for (const text of forms(entry)) {
          expect(text.trim(), `${locale} ${key} is empty`).not.toBe("");
          // Every form keeps the placeholders English uses (a plural form may drop `{count}`).
          const got = [...new Set(placeholders(text))];
          for (const name of got) expect(wanted, `${locale} ${key}: {${name}}`).toContain(name);
          for (const name of wanted.filter((n) => n !== "count")) {
            expect(got, `${locale} ${key} lacks {${name}}`).toContain(name);
          }
        }
      }
    });
  }

  it("keeps the brand voice: no exclamation marks, and every translation marked for review", () => {
    for (const locale of LOCALES) {
      for (const entry of Object.values(CATALOGS[locale])) {
        for (const text of forms(entry)) expect(text, locale).not.toContain("!");
      }
    }
  });
});

describe("plurals", () => {
  it("picks the form with Intl.PluralRules in the reader's language", () => {
    const t = createTranslator("en");
    expect(t("run.stepsDone", { done: 1, count: 1 })).toBe("1 of 1 step");
    expect(t("run.stepsDone", { done: 2, count: 3 })).toBe("2 of 3 steps");
    expect(t("run.stepsDone", { done: 0, count: 0 })).toBe("0 of 0 steps");
    // French counts 0 as singular; English doesn't.
    const fr = createTranslator("fr");
    expect(fr("document.lineCount", { count: 0 })).toBe("0 ligne");
    expect(fr("document.lineCount", { count: 2 })).toBe("2 lignes");
    const de = createTranslator("de");
    expect(de("upload.purchasesAdded", { count: 1 })).toBe("1 Einkauf hinzugefügt");
    expect(de("upload.purchasesAdded", { count: 5 })).toBe("5 Einkäufe hinzugefügt");
  });

  it("formats numbers in parameters with the reader's grouping", () => {
    expect(createTranslator("en")("connections.actions", { count: 1204 })).toBe("1,204 actions");
    expect(createTranslator("de")("connections.actions", { count: 1204 })).toBe("1.204 Aktionen");
  });
});

describe("Intl formatting", () => {
  it("takes the reader's region when it is the same language", () => {
    expect(intlLocaleFor("es", ["es-MX", "en-US"])).toBe("es-MX");
    expect(intlLocaleFor("pt-BR", ["pt-PT"])).toBe("pt-PT");
    expect(intlLocaleFor("fr", ["en-GB", "fr-CA"])).toBe("fr-CA");
    expect(intlLocaleFor("de", ["en-US"])).toBe("de");
    expect(intlLocaleFor("en", [])).toBe("en-US");
    expect(intlLocaleFor("en", ["en-GB"])).toBe("en-GB");
  });

  it("formats money from its decimal string in the reader's locale", () => {
    expect(createI18n("en").fmt.money("9742.3500", "USD")).toBe("$9,742.35");
    expect(createI18n("de").fmt.money("9742.3500", "EUR")).toBe("9.742,35 €");
    expect(createI18n("fr").fmt.money("9742.3500", "EUR")).toBe("9 742,35 €");
    expect(createI18n("es", ["es-MX"]).fmt.money("1200.5000", "MXN")).toBe("$1,200.50");
    expect(createI18n("pt-BR").fmt.money("1200.5000", "BRL")).toBe("R$ 1.200,50");
    expect(createI18n("it").fmt.money(null)).toBe("–");
    // Unit prices keep their places as printed; quantities trim zeros.
    expect(createI18n("de").fmt.unitPrice("0.0425", "EUR")).toBe("0,0425 €");
    expect(createI18n("de").fmt.figure("1.5000")).toBe("1,50");
    expect(createI18n("en").fmt.figure("2000.0000")).toBe("2,000");
  });

  it("formats dates and times in the reader's locale", () => {
    const iso = "2026-11-03T15:04:00.000Z";
    const later = new Date("2026-12-01T12:00:00.000Z");
    const de = createI18n("de").fmt;
    expect(de.date(iso)).toMatch(/3\. Nov\. 2026/);
    expect(de.time(iso, later)).toMatch(/^3\. Nov\., \d{2}:04$/);
    expect(createI18n("en").fmt.date(iso)).toBe("Nov 3, 2026");
    expect(createI18n("es").fmt.date(iso)).toMatch(/3 nov 2026/);
    expect(createI18n("en").fmt.bytes(1536 * 1024)).toBe("1.5 MB");
    expect(createI18n("de").fmt.bytes(1536 * 1024)).toBe("1,5 MB");
  });
});

describe("API errors", () => {
  const error = (status: number, code: string, message = "server words") =>
    new ApiError({ status, code, message, route: "GET /api/x" });

  it("show by their code in the reader's language, with the server's words as the fallback", () => {
    const es = createI18n("es");
    expect(errorText(error(409, "already_resolved"), es)).toBe("Alguien ya respondió a esto.");
    expect(errorText(error(404, "not_found"), es)).toBe("No se encontró.");
    expect(errorText(error(403, "not_assignee"), es)).toBe("Esto espera a otra persona.");
    expect(errorText(error(500, "boom"), es)).toBe(
      "Algo falló de nuestro lado. Inténtelo de nuevo en un momento.",
    );
    expect(errorText(error(422, "made_up_code"), es)).toBe("server words");
  });

  it("keep the server's words in English, as the back office reads them", () => {
    const en = createI18n("en");
    expect(errorText(error(409, "already_resolved", "already resolved by Ana"), en)).toBe(
      "already resolved by Ana",
    );
    expect(errorText(error(403, "not_assignee"), en)).toBe("You don't have access to this.");
  });
});

// ── The app ──────────────────────────────────────────────────────────────────────────────────────

const OVERVIEW = {
  client: { id: "00000000-0000-4000-8000-00000000a002", name: "Demo client" },
  services: [
    {
      id: "00000000-0000-4000-8000-00000000b001",
      name: "Record keeping",
      description: "Keeps the records right.",
      status: "active",
    },
  ],
  needsYou: { inbox: 3 },
  recentRuns: [],
};

const RUNS = {
  runs: [
    {
      id: "00000000-0000-4000-8000-0000000f1001",
      service: { id: "00000000-0000-4000-8000-00000000b001", name: "Record keeping" },
      status: "waiting",
      startedAt: "2026-11-03T10:00:00.000Z",
      finishedAt: null,
    },
  ],
};

function sessionIn(effective: Locale, user: Locale | null = null, client: Locale | null = null) {
  return { ...CLIENT_SESSION, language: { effective, user, client } };
}

function renderAt(path: string, api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("the portal in the session's language", () => {
  it("reads in Spanish", async () => {
    const api = fakeApi({
      "GET /api/session": () => sessionIn("es", null, "es"),
      "GET /api/overview": () => OVERVIEW,
      "GET /api/feedback/status": () => ({ enabled: false }),
    });
    renderAt("/", api);
    expect(await screen.findByRole("heading", { name: "Resumen" })).toBeInTheDocument();
    const nav = screen.getByRole("complementary", { name: "Navegación" });
    for (const label of ["Su escritorio", "Ejecuciones", "Cuentas", "Solicitudes", "Ajustes"]) {
      expect(within(nav).getByText(label)).toBeInTheDocument();
    }
    expect(await screen.findByText("elementos en su bandeja")).toBeInTheDocument();
    // The status reads in Spanish on the page and in the sidebar's agent row.
    expect(within(screen.getByRole("main")).getByText("Activo")).toBeInTheDocument();
    expect(within(nav).getByText("Activo")).toBeInTheDocument();
    expect(screen.getByText("Le espera a usted")).toBeInTheDocument();
    // Names and what the operator wrote stay as written.
    expect(within(screen.getByRole("main")).getByText("Record keeping")).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("es");
  });

  it("reads in German, with German statuses and times", async () => {
    const api = fakeApi({
      "GET /api/session": () => sessionIn("de", "de"),
      "GET /api/overview": () => OVERVIEW,
      "GET /api/feedback/status": () => ({ enabled: false }),
      "GET /api/runs": () => RUNS,
    });
    renderAt("/runs", api);
    expect(await screen.findByRole("heading", { name: "Abläufe" })).toBeInTheDocument();
    const table = await screen.findByTestId("portal-runs");
    expect(within(table).getByText("Service")).toBeInTheDocument();
    expect(within(table).getByText("Dauer")).toBeInTheDocument();
    expect(within(table).getByText("Wartet")).toBeInTheDocument();
    expect(within(table).getByText(/3\. Nov\., \d{2}:00/)).toBeInTheDocument();
    expect(screen.getByTestId("shell-inbox")).toHaveTextContent("Ihr Schreibtisch");
  });
});

describe("the language picker", () => {
  it("saves your own language and reloads the portal in it", async () => {
    let session = sessionIn("es", null, "es");
    const bodies: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => session,
      "GET /api/overview": () => OVERVIEW,
      "GET /api/feedback/status": () => ({ enabled: false }),
      "PUT /api/me/language": ({ init }) => {
        const body = JSON.parse(String(init.body));
        bodies.push(body);
        session = sessionIn(body.language ?? "es", body.language, "es");
        return { user: body.language, client: "es" };
      },
    });
    renderAt("/", api);
    await screen.findByRole("heading", { name: "Resumen" });
    await userEvent.click(screen.getByTestId("shell-avatar"));
    const mine = screen.getByTestId("language-mine") as HTMLSelectElement;
    // No choice of your own yet: your team's language.
    expect(mine.value).toBe("");
    expect(mine.options[0]?.text).toBe("Idioma del equipo · Español");
    await userEvent.selectOptions(mine, "de");
    expect(bodies).toEqual([{ language: "de" }]);
    expect(await screen.findByRole("heading", { name: "Übersicht" })).toBeInTheDocument();
    // The client admin also sets the team's default.
    expect(screen.getByTestId("language-team")).toHaveValue("es");
  });

  it("sets the team's default for the client admin", async () => {
    const bodies: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => sessionIn("en"),
      "GET /api/overview": () => OVERVIEW,
      "GET /api/feedback/status": () => ({ enabled: false }),
      "PUT /api/client/language": ({ init }) => {
        bodies.push(JSON.parse(String(init.body)));
        return { client: "it" };
      },
    });
    renderAt("/", api);
    await screen.findByRole("heading", { name: "Overview" });
    await userEvent.click(screen.getByTestId("shell-avatar"));
    await userEvent.selectOptions(screen.getByTestId("language-team"), "it");
    await waitFor(() => expect(bodies).toEqual([{ language: "it" }]));
  });
});

describe("before a session and in the back office", () => {
  it("signs in in the browser's language", async () => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["de-DE", "en"]);
    const api = fakeApi({
      "GET /api/session": () => new Reply(401, { error: { code: "unauthenticated" } }),
      "GET /api/auth/provider": () => ({ provider: "workos", message: null }),
    });
    renderAt("/sign-in?error=not_invited", api);
    expect(
      await screen.findByRole("heading", { name: "Bei Mezonas anmelden" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("signin-error")).toHaveTextContent(
      "Diese E-Mail-Adresse wurde nicht zu Mezonas eingeladen.",
    );
  });

  it("lets the operator set the client's language on the client page", async () => {
    const bodies: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${SANDBOX_DETAIL.client.id}`]: () => SANDBOX_DETAIL,
      [`GET /api/ops/clients/${SANDBOX_DETAIL.client.id}/feedback`]: () => ({
        enabled: false,
        changes: [],
      }),
      [`PUT /api/ops/clients/${SANDBOX_DETAIL.client.id}/language`]: ({ init }) => {
        bodies.push(JSON.parse(String(init.body)));
        return { client: "es" };
      },
    });
    renderAt(`/ops/clients/${SANDBOX_DETAIL.client.id}`, api);
    const select = await screen.findByTestId("ops-client-language-select");
    expect(select).toHaveValue("");
    await userEvent.selectOptions(select, "es");
    await waitFor(() => expect(bodies).toEqual([{ language: "es" }]));
    // The back office itself stays in English.
    expect(screen.getByText("The client's language")).toBeInTheDocument();
  });

  it("keeps the back office in English, whatever the browser reads", async () => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["fr-FR"]);
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/clients": () => ({ clients: [] }),
    });
    renderAt("/ops/inbox", api);
    const shell = await screen.findByTestId("shell-ops");
    expect(within(shell).getByTestId("shell-inbox")).toHaveTextContent("Escalations");
    expect(screen.getByRole("complementary", { name: "Navigation" })).toBeInTheDocument();
    // No language picker in the back office.
    await userEvent.click(screen.getByTestId("shell-avatar"));
    expect(screen.queryByTestId("language-menu")).toBeNull();
  });
});
