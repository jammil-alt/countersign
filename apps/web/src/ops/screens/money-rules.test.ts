// PLATFORM_QA CONS lens (consistency): the web app's number rules are the server's own (money as
// `numeric(14,4)`, credits at most 100,000,000), so a value the form takes is never refused after
// Save, and one the server would refuse is refused on the page.
import {
  BillingSettings,
  fieldValueSchema,
  type PortalGuideField,
  SetAgentPrice,
} from "@countersign/core";
import { describe, expect, it } from "vitest";
import { draftValue } from "../../portal/screens/GettingStarted";
import { priceFromDraft } from "../agents/PricePanel";
import { settingsFromDraft } from "./Billing";

const MONEY_FIELD = { key: "area.purchasing.budget", kind: "money" } as unknown as PortalGuideField;

describe("CONS: the web's number rules against the server's", () => {
  it("(PLATFORM_QA CONS-4) an intake money answer the form sends is one the server's money schema takes", () => {
    const refused: string[] = [];
    const sent: string[] = [];
    for (const typed of ["250", "250.50", "$12,500", "12345678901", "99999999999.99"]) {
      const value = draftValue(MONEY_FIELD, typed);
      if (value === undefined) continue;
      sent.push(typed);
      if (!fieldValueSchema("money").safeParse(value).success) refused.push(typed);
    }
    expect(refused).toEqual([]);
    // More than 10 digits is refused on the page, as the server refuses it.
    expect(sent).toEqual(["250", "250.50", "$12,500"]);
  });

  it("(PLATFORM_QA CONS-4) an agent's price the Price panel accepts is one SetAgentPrice takes", () => {
    const refused: string[] = [];
    const accepted: string[] = [];
    for (const [monthly, credits] of [
      ["250", "2000"],
      ["250", "100000000"],
      ["250", "999999999"],
    ] as const) {
      const p = priceFromDraft(monthly, credits);
      if ("problem" in p) continue;
      accepted.push(credits);
      if (!SetAgentPrice.safeParse({ price: p, note: "x" }).success) refused.push(credits);
    }
    expect(refused).toEqual([]);
    expect(accepted).toEqual(["2000", "100000000"]);
    expect(priceFromDraft("250", "999999999")).toEqual({
      problem: "The credits included are a whole number up to 100,000,000.",
    });
  });

  it("(PLATFORM_QA CONS-4) billing settings the Billing form accepts are ones BillingSettings takes", () => {
    const draft = {
      defaultAgentPrice: "250",
      defaultIncludedCredits: "2000",
      creditPrice: "0.01",
      phoneLinePrice: "10",
      autoSend: false,
      daysUntilDue: "30",
      unitCosts: [],
    };
    for (const credits of ["2000", "100000000", "500000000"]) {
      const out = settingsFromDraft({ ...draft, defaultIncludedCredits: credits });
      if ("problem" in out) {
        // Refused on the page only where the server would refuse it too.
        expect(credits).toBe("500000000");
        expect(out.problem).toBe("The credits included are a whole number up to 100,000,000.");
        continue;
      }
      expect(BillingSettings.safeParse(out.settings).success, credits).toBe(true);
    }
  });
});
