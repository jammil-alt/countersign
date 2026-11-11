// One language in the bundle (docs/audit-plan.md 4.1): English is always there; another language
// loads once it is asked for, and a screen never reads a key while it does.
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  it("has English from the start and the others only once loaded", async () => {
    expect(loadedCatalog("en")?.["common.loading"]).toBe("Loading…");
    expect(loadedCatalog("es")).toBeUndefined();
    // Asked before it loaded: English words, never the key.
    expect(createTranslator("es")("common.loading")).toBe("Loading…");
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
