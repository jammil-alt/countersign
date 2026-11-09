import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
    // A path, not a URL: the Workers and Node URL types differ under @types/node 24.
    const path = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url).href);
    const config = readFileSync(path, "utf8");
    const values = [...config.matchAll(/"EMAIL_CODES"\s*:\s*"([^"]*)"/g)].map((m) => m[1]);
    expect(values).toEqual(["off", "off", "off"]);
  });
});
