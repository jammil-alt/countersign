// The keys in one spelling, and the rules' score (docs/plan.md §1.164 "The match"). No database.

import { describe, expect, it } from "vitest";
import { keysOf, matchTextFieldsFrom, matchTextOf } from "../keys/build";
import {
  companyDomain,
  normalizeCompany,
  normalizeCrmPhone,
  normalizeEmail,
  normalizePerson,
  websiteDomain,
} from "../keys/normalize";
import { zohoMapper } from "../keys/zoho";
import { matchOnFrom, rowKeys, rowValues, thresholdFrom } from "./match";
import { decideByRules, MATCH_THRESHOLD, scorePair } from "./score";
import { companySimilarity, personSimilarity, trigramSimilarity } from "./similar";

describe("keys in one spelling", () => {
  it("reads emails, phones and domains, or leaves them out", () => {
    expect(normalizeEmail(" Jane.Doe@BlueRidge.COM ")).toBe("jane.doe@blueridge.com");
    expect(normalizeEmail("mailto:x@y.io")).toBe("x@y.io");
    expect(normalizeEmail("not an email")).toBeNull();
    expect(normalizeCrmPhone("(512) 555-0177")).toBe("+15125550177");
    expect(normalizeCrmPhone("512.555.0177 ext. 23")).toBe("+15125550177");
    expect(normalizeCrmPhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizeCrmPhone(5125550177)).toBe("+15125550177");
    expect(normalizeCrmPhone("555-0177")).toBeNull();
    expect(normalizeCrmPhone("512 555 0177 x9")).toBe("+15125550177");
    expect(normalizeCrmPhone("5125550177#4")).toBe("+15125550177");
    // A long run of spaces is refused at once, never scanned by a pattern.
    expect(normalizeCrmPhone(`5125550177${" ".repeat(50_000)}x`)).toBeNull();
    expect(websiteDomain("https://www.Acme.com/about?x=1")).toBe("acme.com");
    expect(websiteDomain("acme")).toBeNull();
    expect(companyDomain({ email: "jane@acme.com" })).toBe("acme.com");
    // A free mail service's domain says nothing about a company.
    expect(companyDomain({ email: "jane@gmail.com" })).toBeNull();
  });

  it("reads company and person names as words, legal forms and honorifics dropped", () => {
    expect(normalizeCompany("The ACME Corporation")).toBe("acme");
    expect(normalizeCompany("Acme, L.L.C.")).toBe("acme");
    expect(normalizeCompany("Cedar & Pine Builders")).toBe("cedar and pine builders");
    expect(normalizeCompany("Co")).toBe("co");
    expect(normalizePerson("Doe, Jane")).toBe("jane doe");
    expect(normalizePerson("Ms. José Álvarez Jr.")).toBe("jose alvarez");
    expect(normalizePerson(undefined, { first: "Michael", last: "O'Brien" })).toBe(
      "michael obrien",
    );
  });

  it("reads a Zoho deal's account and contact from their lookups", () => {
    const mapped = zohoMapper.map("Deals", {
      Deal_Name: "Acme - Website Redesign",
      Account_Name: { name: "Acme Corporation", id: "1" },
      Contact_Name: { name: "Daniel Park", id: "2" },
      Stage: "Proposal",
      Amount: 18000,
    });
    expect(keysOf(mapped?.fields ?? {})).toEqual({
      company: "acme",
      name: "daniel park",
      deal: "acme website redesign",
    });
    expect(mapped?.display).toMatchObject({ stage: "Proposal", amount: "18000" });
    expect(zohoMapper.map("Unknown", {})).toBeNull();
  });

  it("builds the match text from the client's fields, the names by default", () => {
    const keys = keysOf({ name: "Jane Doe", company: "Acme", email: "jane@acme.com" });
    expect(matchTextOf(keys, matchTextFieldsFrom({}))).toBe("jane doe | acme");
    expect(
      matchTextOf(keys, matchTextFieldsFrom({ sales: { matchText: ["email", "name"] } })),
    ).toBe("jane doe | jane@acme.com");
  });
});

describe("similar names", () => {
  it("counts trigrams as pg_trgm does", () => {
    expect(trigramSimilarity("word", "word")).toBe(1);
    expect(trigramSimilarity("abc", "xyz")).toBe(0);
  });

  it("reads word order, nicknames, initials and middle names", () => {
    expect(personSimilarity("doe jane", "jane doe")).toBe(1);
    expect(personSimilarity("bob chen", "robert chen")).toBe(1);
    expect(personSimilarity("j doe", "jane doe")).toBeGreaterThanOrEqual(0.85);
    expect(personSimilarity("jane m doe", "jane doe")).toBeGreaterThanOrEqual(0.9);
    expect(personSimilarity("jane doe", "jane smith")).toBeLessThan(0.5);
  });

  it("reads one company written two ways, and keeps a longer name apart", () => {
    expect(companySimilarity("blue line", "blueline")).toBeGreaterThanOrEqual(0.9);
    expect(companySimilarity("acme", "acme industries")).toBe(0.8);
  });
});

describe("the rules' score", () => {
  const record = keysOf({
    name: "Jane Doe",
    company: "Blue Ridge Millwork",
    email: "jane@blueridge.com",
    phone: "828-555-0101",
  });

  it("matches an exact email, and an exact phone whose names agree", () => {
    expect(scorePair({ email: "jane@blueridge.com" }, record, { kind: "person" })).toMatchObject({
      score: 1,
      key: "email",
      vetoed: null,
    });
    const phone = scorePair(keysOf({ phone: "828 555 0101", name: "Jane Doe" }), record, {
      kind: "person",
    });
    expect(phone).toMatchObject({ key: "phone" });
    expect(phone.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
  });

  it("vetoes two different emails or phones, whatever else agrees", () => {
    const email = scorePair(
      keysOf({ email: "jdoe@blueridge.com", name: "Jane Doe", company: "Blue Ridge Millwork" }),
      record,
      { kind: "person" },
    );
    expect(email).toMatchObject({ score: 0, vetoed: "email" });
    const phone = scorePair(keysOf({ phone: "828-555-0199", name: "Jane Doe" }), record, {
      kind: "person",
    });
    expect(phone.vetoed).toBe("phone");
  });

  it("takes a shared main line for no match when the names disagree", () => {
    const s = scorePair(keysOf({ phone: "828-555-0101", name: "Peter Hall" }), record, {
      kind: "person",
    });
    expect(s.score).toBeLessThan(MATCH_THRESHOLD);
  });

  it("matches a name with its company, never a name alone", () => {
    const both = scorePair(
      keysOf({ name: "Jane Doe", company: "Blue Ridge Millwork Inc" }),
      record,
      {
        kind: "person",
      },
    );
    expect(both.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    const alone = scorePair(keysOf({ name: "Jane Doe" }), record, { kind: "person" });
    expect(alone.score).toBeLessThan(MATCH_THRESHOLD);
    const elsewhere = scorePair(keysOf({ name: "Jane Doe", company: "Atlas Fitness" }), record, {
      kind: "person",
    });
    expect(elsewhere.score).toBeLessThan(0.5);
  });

  it("compares only the fields the step names", () => {
    const s = scorePair(
      keysOf({ email: "other@blueridge.com", name: "Jane Doe", company: "Blue Ridge Millwork" }),
      record,
      { kind: "person", fields: ["name", "company"] },
    );
    expect(s.vetoed).toBeNull();
    expect(s.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
  });

  it("leaves two sure records to a person", () => {
    const pair = { score: 1, key: "email" as const, vetoed: null, agree: [], differ: [] };
    expect(decideByRules([{ candidate: "a", pair }], 0.9).kind).toBe("matched");
    expect(
      decideByRules(
        [
          { candidate: "a", pair },
          { candidate: "b", pair },
        ],
        0.9,
      ).kind,
    ).toBe("open");
    expect(decideByRules([], 0.9).kind).toBe("nothing");
  });
});

describe("the step's settings and a row's values", () => {
  it("reads the threshold and the fields to compare, refusing a word it doesn't know", () => {
    expect(thresholdFrom({})).toBe(MATCH_THRESHOLD);
    expect(thresholdFrom({ match_threshold: 0.95 })).toBe(0.95);
    expect(thresholdFrom({ match_threshold: 7 })).toBe(MATCH_THRESHOLD);
    expect(matchOnFrom({ match_on: "Website, email , name" })).toEqual(["email", "domain", "name"]);
    expect(matchOnFrom({ match_on: "" })).toBeNull();
    expect(() => matchOnFrom({ match_on: "email, shoe size" })).toThrow(/shoe size/);
  });

  it("reads only the mapped fields of a row, never a prototype's", () => {
    const row = JSON.parse(
      '{"First":"Jane","Last":"Doe","Mail":"JANE@ACME.COM","__proto__":{"x":1}}',
    );
    const values = rowValues(row, { firstName: "First", lastName: "Last", email: "Mail" });
    expect(values).toEqual({ firstName: "Jane", lastName: "Doe", email: "JANE@ACME.COM" });
    expect(rowKeys(values)).toEqual({
      email: "jane@acme.com",
      domain: "acme.com",
      name: "jane doe",
    });
    expect(rowValues(row, { name: "toString" })).toEqual({});
  });
});
