// CONS lens (consistency): the web app's own copies of the server's number rules (money as
// `numeric(14,4)`, credits at most 100,000,000) accept values the server's schemas refuse, so the
// person's typed value passes the form and is refused after Save.
import {
  BillingSettings,
  fieldValueSchema,
  type PortalGuideField,
  SetAgentPrice,
} from "@countersign/core";
import { describe, expect, it } from "vitest";
import { priceFromDraft } from "../ops/agents/PricePanel";
import { settingsFromDraft } from "../ops/screens/Billing";
import { draftValue } from "../portal/screens/GettingStarted";

const MONEY_FIELD = { key: "area.purchasing.budget", kind: "money" } as unknown as PortalGuideField;

describe("CONS: the web's number rules against the server's", () => {
  it("CONS-6: an intake money answer the form sends is one the server's money schema takes", () => {
    const refused: string[] = [];
    for (const typed of ["250", "250.50", "12345678901", "99999999999.99"]) {
      const value = draftValue(MONEY_FIELD, typed);
      if (value === undefined) continue;
      if (!fieldValueSchema("money").safeParse(value).success) refused.push(typed);
    }
    expect(refused).toEqual([]);
  });

  it("CONS-6: an agent's price the Price panel accepts is one SetAgentPrice takes", () => {
    const refused: string[] = [];
    for (const [monthly, credits] of [
      ["250", "2000"],
      ["250", "100000000"],
      ["250", "999999999"],
    ] as const) {
      const p = priceFromDraft(monthly, credits);
      if ("problem" in p) continue;
      if (!SetAgentPrice.safeParse({ price: p, note: "x" }).success) refused.push(credits);
    }
    expect(refused).toEqual([]);
  });

  it("CONS-6: billing settings the Billing form accepts are ones BillingSettings takes", () => {
    const draft = {
      defaultAgentPrice: "250",
      defaultIncludedCredits: "500000000",
      creditPrice: "0.01",
      autoSend: false,
      daysUntilDue: "30",
      unitCosts: [],
    };
    const out = settingsFromDraft(draft);
    expect("problem" in out).toBe(false);
    if ("problem" in out) return;
    expect(BillingSettings.safeParse(out.settings).success).toBe(true);
  });
});
