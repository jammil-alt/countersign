// P-7: a message's translation shows first, marked with its language, and the original is one
// click away (docs/plan.md §1.69); without a translation, the original as before.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../i18n/i18n";
import { TranslatedText } from "./translated";

const ORIGINAL = "Hi, can you send the quote by tomorrow?";
const SPANISH = "Hola, ¿puede enviar la cotización para mañana?";

describe("TranslatedText", () => {
  it("shows the translation first, with the original one click away", () => {
    render(
      <I18nProvider locale="es" browser={["es"]}>
        <TranslatedText
          testId="m"
          text={ORIGINAL}
          translation={{ status: "translated", from: "en", text: SPANISH, truncated: false }}
        />
      </I18nProvider>,
    );
    const box = screen.getByTestId("m");
    expect(box.textContent).toContain(SPANISH);
    expect(box.textContent).toContain("Traducido del inglés");
    expect(box.textContent).not.toContain(ORIGINAL);
    fireEvent.click(screen.getByRole("button", { name: "Ver original" }));
    expect(box.textContent).toContain(ORIGINAL);
    fireEvent.click(screen.getByRole("button", { name: "Ver traducción" }));
    expect(box.textContent).toContain(SPANISH);
  });

  it("shows only the original when nothing was translated", () => {
    render(
      <I18nProvider locale="en" browser={["en"]}>
        <TranslatedText
          testId="m"
          text={ORIGINAL}
          translation={{ status: "capped", from: "en", text: null, truncated: false }}
        />
      </I18nProvider>,
    );
    expect(screen.getByTestId("m").textContent).toBe(ORIGINAL);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says when only the first part was translated", () => {
    render(
      <I18nProvider locale="en" browser={["en"]}>
        <TranslatedText
          testId="m"
          text={ORIGINAL}
          translation={{ status: "translated", from: "es", text: "Hello", truncated: true }}
        />
      </I18nProvider>,
    );
    expect(screen.getByTestId("m").textContent).toContain("Translated the first 6,000 characters");
  });
});
