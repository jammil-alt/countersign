import { describe, expect, it } from "vitest";
import {
  addMoney,
  compareMoney,
  dec,
  formatAmount,
  MoneySchema,
  money,
  moneyEquals,
  mulMoney,
  percentChange,
  subMoney,
  sumMoney,
  toNumeric,
  withinTolerance,
} from "./money";

describe("money", () => {
  it("adds without float error", () => {
    expect(addMoney(money("0.1", "USD"), money("0.2", "USD")).amount).toBe("0.3000");
  });

  it("rounds to numeric(14,4) half up", () => {
    expect(toNumeric("1.23455")).toBe("1.2346");
    expect(toNumeric("-1.23455")).toBe("-1.2346");
    expect(mulMoney(money("10.00", "USD"), "0.33333").amount).toBe("3.3333");
  });

  it("refuses JS numbers and mixed currencies", () => {
    expect(() => dec(0.1 as unknown as string)).toThrow(/never JS numbers/);
    expect(() => addMoney(money("1", "USD"), money("1", "CAD"))).toThrow(/currency/);
    expect(() => sumMoney([money("1", "CAD")], "USD")).toThrow(/currency/);
  });

  it("sums, subtracts and compares", () => {
    const total = sumMoney([money("1.10", "USD"), money("2.20", "USD")], "USD");
    expect(total).toEqual({ amount: "3.3000", currency: "USD" });
    expect(subMoney(total, money("0.3", "USD")).amount).toBe("3.0000");
    expect(compareMoney(money("2", "USD"), money("10", "USD"))).toBe(-1);
    expect(moneyEquals(money("2", "USD"), money("2.0000", "USD"))).toBe(true);
  });

  it("checks tolerances and percent changes in decimals", () => {
    expect(withinTolerance("100.00", "100.02", "0.02")).toBe(true);
    expect(withinTolerance("100.00", "100.03", "0.02")).toBe(false);
    expect(percentChange("80", "92")?.toString()).toBe("15");
    expect(percentChange("0", "5")).toBeNull();
    expect(formatAmount("1234.505")).toBe("1234.51");
  });

  it("validates the wire shape", () => {
    expect(MoneySchema.safeParse({ amount: "12.5", currency: "USD" }).success).toBe(true);
    expect(MoneySchema.safeParse({ amount: 12.5, currency: "USD" }).success).toBe(false);
    expect(MoneySchema.safeParse({ amount: "1.23456", currency: "USD" }).success).toBe(false);
    expect(MoneySchema.safeParse({ amount: "1", currency: "usd" }).success).toBe(false);
  });
});
