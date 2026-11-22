import { describe, expect, it } from "vitest";
import { colleagueAddress } from "./colleague";

describe("colleagueAddress", () => {
  it("finds another address at the contact's own domain, the From header's first", () => {
    expect(colleagueAddress("sam@acme.example", ["lee@acme.example", "bounce@acme.example"])).toBe(
      "lee@acme.example",
    );
    expect(colleagueAddress("Sam@ACME.example", [null, "Bounce@Acme.Example"])).toBe(
      "bounce@acme.example",
    );
  });

  it("is never the contact's own address, another domain, a subdomain or a free mail service", () => {
    expect(colleagueAddress("sam@acme.example", ["SAM@acme.example"])).toBeNull();
    expect(colleagueAddress("sam@acme.example", ["lee@evil.example", undefined, ""])).toBeNull();
    expect(colleagueAddress("sam@acme.example", ["lee@mail.acme.example"])).toBeNull();
    expect(colleagueAddress("sam@acme.example", ["lee@acme.example.evil"])).toBeNull();
    expect(colleagueAddress("sam@gmail.com", ["lee@gmail.com"])).toBeNull();
    expect(colleagueAddress("not an address", ["lee@acme.example"])).toBeNull();
  });
});
