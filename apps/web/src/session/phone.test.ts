// A phone number for sign-in codes, as people type it, in E.164 (core's normalizePhone).
import { describe, expect, it } from "vitest";
import { defaultPhoneCountry, phoneCountryOptions, phoneToE164 } from "./phone";

describe("phoneToE164", () => {
  it("adds the picked country's code to a national number", () => {
    expect(phoneToE164("(415) 555-0123", "US")).toBe("+14155550123");
    expect(phoneToE164("1 415 555 0123", "US")).toBe("+14155550123");
    expect(phoneToE164("07700 900123", "GB")).toBe("+447700900123");
    expect(phoneToE164("0151 1234 5678", "DE")).toBe("+4915112345678");
    expect(phoneToE164("(11) 91234-5678", "BR")).toBe("+5511912345678");
  });

  it("keeps Italy's leading 0", () => {
    expect(phoneToE164("06 1234 5678", "IT")).toBe("+390612345678");
  });

  it("keeps a number's own country code, whatever country is picked", () => {
    expect(phoneToE164("+44 7700 900123", "US")).toBe("+447700900123");
    expect(phoneToE164("0033 6 12 34 56 78", "US")).toBe("+33612345678");
  });

  it("refuses what isn't a phone number", () => {
    expect(phoneToE164("", "US")).toBeNull();
    expect(phoneToE164("555 12", "US")).toBeNull();
    expect(phoneToE164("call me", "US")).toBeNull();
    expect(phoneToE164("+0 123 456", "US")).toBeNull();
    expect(phoneToE164("12", "FR")).toBeNull();
    expect(phoneToE164("415 555 0123", "XX")).toBeNull();
  });
});

describe("the country list", () => {
  it("starts from the browser's region, else the US", () => {
    expect(defaultPhoneCountry(["pt-BR", "en"])).toBe("BR");
    expect(defaultPhoneCountry(["fr", "de-AT"])).toBe("AT");
    expect(defaultPhoneCountry(["en"])).toBe("US");
    expect(defaultPhoneCountry(["not a tag"])).toBe("US");
  });

  it("names the countries in the reader's language, with their codes", () => {
    const de = phoneCountryOptions("de");
    expect(de.find((c) => c.code === "DE")?.label).toBe("Deutschland (+49)");
    const en = phoneCountryOptions("en").map((c) => c.label);
    expect(en).toContain("United States (+1)");
    expect(en).toEqual([...en].sort((a, b) => a.localeCompare(b, "en")));
  });
});
