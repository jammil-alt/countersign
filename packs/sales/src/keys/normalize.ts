// The Sales area's keys in one spelling (docs/plan.md §1.164 "The match"), for a synced record and
// for a row alike, so the same person or company reads the same from both: email lowercased, phone
// in E.164, the website's domain (or the email's, when it isn't a free mail service's), company and
// person names as lowercase words with the noise dropped. Pure: no I/O. A value that doesn't read
// as its kind is no key (null), never a guess.

import { normalizeSignupPhone } from "@countersign/core";

const EMAIL_RE = /^[^\s@<>()[\],;:"]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9-]{1,63})+$/;
const HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Text as words: no accents, lowercase, `&` as "and", punctuation as spaces, one space between. */
export function words(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** An email address, lowercased; null when it isn't one. */
// DECISION: no provider-specific folding (Gmail's dots and `+tags`): two spellings a mail service
// may deliver to the same box are still two keys, so an exact email never joins two people.
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw
    .trim()
    .replace(/^mailto:/i, "")
    .toLowerCase();
  return v.length <= 254 && EMAIL_RE.test(v) ? v : null;
}

/** A phone number in E.164; null when it isn't one. An extension is dropped. */
// DECISION: core's sign-up reading (international form, or a 10-digit US or Canadian number as +1),
// applied to records and rows alike, so both sides of a match read a number the same way. A number
// without its country that isn't North American is no key.
export function normalizeCrmPhone(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const v = String(raw)
    .trim()
    .replace(/\s*(?:ext\.?|extension|x|#)\s*\d{1,6}$/i, "");
  if (!/\d/.test(v) || v.length > 40) return null;
  return normalizeSignupPhone(v);
}

/** Mail services anyone can sign up to: their domain says nothing about a company. */
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.uk",
  "ymail.com",
  "hotmail.com",
  "hotmail.co.uk",
  "outlook.com",
  "live.com",
  "msn.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "gmx.de",
  "mail.com",
  "zoho.com",
  "zohomail.com",
  "yandex.com",
  "comcast.net",
  "att.net",
  "verizon.net",
  "sbcglobal.net",
  "bellsouth.net",
  "cox.net",
  "earthlink.net",
]);

/** A website's host without `www.`; null when it isn't one. */
export function websiteDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let v = raw.trim().toLowerCase();
  if (!v || v.length > 500) return null;
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  v = v.split(/[/?#]/)[0] ?? "";
  v = v
    .replace(/^[^@]*@/, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
  v = v.replace(/^www\d?\./, "");
  return HOST_RE.test(v) ? v : null;
}

/** The company's domain: its website's, else its email's unless that is a free mail service's. */
export function companyDomain(input: { website?: unknown; email?: unknown }): string | null {
  const site = websiteDomain(input.website);
  if (site) return site;
  const email = normalizeEmail(input.email);
  const host = email?.split("@")[1]?.replace(/^www\./, "") ?? null;
  return host && !FREE_MAIL_DOMAINS.has(host) ? host : null;
}

/** Legal forms at the end of a company's name: "Acme Corp." and "ACME Corporation" are one name. */
const COMPANY_SUFFIXES = new Set([
  "inc",
  "incorporated",
  "llc",
  "llp",
  "lp",
  "ltd",
  "limited",
  "corp",
  "corporation",
  "co",
  "company",
  "plc",
  "pllc",
  "pc",
  "pa",
  "gmbh",
  "ag",
  "sa",
  "srl",
  "bv",
  "nv",
  "pty",
  "group",
]);

/** A company's name as lowercase words, its legal form and a leading "the" dropped. */
// DECISION: "group" counts as a legal form here: "Acme Group" and "Acme" are written for one
// company far more often than for two, and the rest of the row (a person, a deal, an email)
// still has to agree before anything matches.
export function normalizeCompany(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const tokens = words(raw).split(" ").filter(Boolean);
  if (tokens[0] === "the" && tokens.length > 1) tokens.shift();
  // "L.L.C." reads as "l l c": joined back before the suffixes go.
  const joined: string[] = [];
  for (const t of tokens) {
    const last = joined[joined.length - 1];
    if (t.length === 1 && last !== undefined && /^[a-z]+$/.test(last) && last.length < 4) {
      const candidate = `${last}${t}`;
      if ([...COMPANY_SUFFIXES].some((s) => s.startsWith(candidate))) {
        joined[joined.length - 1] = candidate;
        continue;
      }
    }
    joined.push(t);
  }
  while (joined.length > 1 && COMPANY_SUFFIXES.has(joined[joined.length - 1] ?? "")) joined.pop();
  const out = joined.join(" ");
  return out || null;
}

const HONORIFICS = new Set(["mr", "mrs", "ms", "miss", "mx", "dr", "prof", "sir", "madam"]);
const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "phd", "md", "esq", "cpa", "dds"]);

/**
 * A person's name as lowercase words, first name first: "Doe, Jane" and "Ms. Jane Doe" are
 * "jane doe". Honorifics and suffixes are dropped.
 */
export function normalizePerson(
  raw: unknown,
  parts?: { first?: unknown; last?: unknown },
): string | null {
  let text = "";
  const first = typeof parts?.first === "string" ? parts.first.trim() : "";
  const last = typeof parts?.last === "string" ? parts.last.trim() : "";
  if (first || last) text = `${first} ${last}`;
  else if (typeof raw === "string") {
    const comma = raw.split(",");
    // "Doe, Jane": the part after the comma is the first name, unless it is only a suffix.
    if (comma.length === 2 && !NAME_SUFFIXES.has(words(comma[1] ?? ""))) {
      text = `${comma[1]} ${comma[0]}`;
    } else text = raw;
  }
  const tokens = words(text)
    .split(" ")
    .filter((t) => t && !HONORIFICS.has(t) && !NAME_SUFFIXES.has(t));
  const out = tokens.join(" ");
  return out || null;
}

/** A deal's name as lowercase words. */
export function normalizeDeal(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const out = words(raw);
  return out || null;
}
