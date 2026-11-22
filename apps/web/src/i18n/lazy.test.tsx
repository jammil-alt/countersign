// No language in the bundle (docs/audit-plan.md 4.1, docs/plan.md §1.208): each language loads
// once it is asked for, English too, and a screen never reads a key while it does. A client in
// another language never fetches English; the back office loads English with its chunk.
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../App";
import { CLIENT_SESSION, fakeApi, OPERATOR_SESSION, Reply } from "../test/fixtures";
import {
  createTranslator,
  loadAllCatalogs,
  loadCatalog,
  loadedCatalog,
  unloadCatalogs,
} from "./catalog";
import { I18nProvider, useI18n } from "./i18n";

describe("languages load one at a time", () => {
  beforeEach(() => unloadCatalogs());
  // The other tests read every language (test/setup.ts).
  afterEach(() => loadAllCatalogs());

  it("has no language from the start, and each only once loaded", async () => {
    expect(loadedCatalog("en")).toBeUndefined();
    expect(loadedCatalog("es")).toBeUndefined();
    // Before any language: the still frame's word, else the key.
    expect(createTranslator("es")("common.loading")).toBe("Loading…");
    expect(createTranslator("es")("common.tryAgain")).toBe("common.tryAgain");
    // Asked before its language loaded but after English: English words, never the key.
    await loadCatalog("en");
    expect(createTranslator("es")("common.tryAgain")).toBe("Try again");
    const one = loadCatalog("es");
    const two = loadCatalog("es");
    expect(await one).toBe(await two);
    expect(loadedCatalog("es")?.["common.loading"]).toBe("Cargando…");
    expect(createTranslator("es")("common.loading")).toBe("Cargando…");
    // Only the language asked for.
    expect(loadedCatalog("de")).toBeUndefined();
  });

  it("a provider given a language not loaded shows English, then that language: never keys", async () => {
    const seen: string[] = [];
    function Probe() {
      const { t } = useI18n();
      const text = t("common.loading");
      seen.push(text);
      return <p data-testid="probe">{text}</p>;
    }
    await loadCatalog("en");
    render(
      <I18nProvider locale="de" browser={["de"]}>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId("probe")).toHaveTextContent("Loading…");
    await act(() => loadCatalog("de"));
    expect(await screen.findByText("Wird geladen…")).toBeInTheDocument();
    expect(seen.every((s) => s === "Loading…" || s === "Wird geladen…")).toBe(true);
  });
});

describe("the app's languages (§1.208)", () => {
  beforeEach(() => unloadCatalogs());
  afterEach(() => loadAllCatalogs());

  const TXN = "00000000-0000-4000-8000-0000000a7001";
  const at = (path: string, api: ReturnType<typeof fakeApi>) =>
    render(
      <MemoryRouter initialEntries={[path]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );

  it("a Spanish client's portal reads in Spanish, and English is never fetched", async () => {
    const api = fakeApi({
      "GET /api/session": () => ({
        ...CLIENT_SESSION,
        language: { effective: "es", user: "es", client: null },
      }),
      "GET /api/overview": () => new Reply(404, {}),
      "GET /api/feedback/status": () => ({ enabled: false }),
      [`GET /api/records/${TXN}`]: () =>
        new Reply(404, { error: { code: "not_found", message: "no record" } }),
    });
    at(`/records/${TXN}`, api);
    expect(await screen.findByTestId("record-not-found")).toHaveTextContent(
      "No hay página de registro para este id.",
    );
    expect(loadedCatalog("es")).toBeDefined();
    expect(loadedCatalog("en")).toBeUndefined();
    expect(loadedCatalog("de")).toBeUndefined();
  });

  it("the back office loads English with its chunk, whatever the operator's language", async () => {
    const api = fakeApi({
      "GET /api/session": () => ({
        ...OPERATOR_SESSION,
        language: { effective: "de", user: "de", client: null },
      }),
    });
    at("/ops", api);
    expect(await screen.findByTestId("ops-command")).toBeInTheDocument();
    expect(loadedCatalog("en")).toBeDefined();
    expect(screen.queryByText(/common\.|ops\./)).toBeNull();
  });
});
