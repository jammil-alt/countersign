import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { emailCodesOn } from "./env";

describe("EMAIL_CODES", () => {
  it("is on only when set to on", () => {
    expect(emailCodesOn({ EMAIL_CODES: "on" })).toBe(true);
    expect(emailCodesOn({ EMAIL_CODES: " ON " })).toBe(true);
    expect(emailCodesOn({ EMAIL_CODES: "off" })).toBe(false);
    expect(emailCodesOn({ EMAIL_CODES: "true" })).toBe(false);
    expect(emailCodesOn({})).toBe(false);
  });

  it("is off in wrangler.jsonc for local development, staging and production", () => {
    const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    const values = [...config.matchAll(/"EMAIL_CODES"\s*:\s*"([^"]*)"/g)].map((m) => m[1]);
    expect(values).toEqual(["off", "off", "off"]);
  });
});
