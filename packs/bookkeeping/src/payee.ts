// Who a bank transaction was with, as a key rules match on (docs/plan.md §1.79). Deterministic:
// the same words always give the same key, so a rule written for "SQ *BLUE BOTTLE 1234 OAKLAND"
// also matches next month's "SQ *BLUE BOTTLE 5678 OAKLAND".

/** Card-network and bank prefixes that say how it was paid, not who was paid. */
const NOISE = new Set([
  "pos",
  "debit",
  "credit",
  "purchase",
  "card",
  "ach",
  "online",
  "payment",
  "pmt",
  "recurring",
  "checkcard",
  "visa",
  "mc",
  "dda",
  "withdrawal",
  "deposit",
  "transfer",
  "xfer",
  "web",
  "id",
  "ppd",
  "ccd",
  "inc",
  "llc",
  "co",
  "corp",
  "ltd",
]);

/** Payment processors' prefixes ("SQ *", "TST*", "PAYPAL *"): the payee follows them. */
const PROCESSOR = /^(sq|tst|sp|pp|paypal|py|pos|in|ck|dd|fs|bt|gg|wl)\s*\*\s*/i;

/** At most this many words make the key. */
const KEY_WORDS = 4;

// DECISION: a key is the first four meaningful words, lowercased, with numbers (store numbers,
// card digits, dates, reference codes) and the payment words above dropped. Empty when nothing is
// left: such a transaction never matches a rule.
export function payeeKey(text: string | null | undefined): string {
  if (!text) return "";
  const words = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(PROCESSOR, "")
    .toLowerCase()
    .replace(/[^a-z0-9& ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0 && !/\d/.test(w) && !NOISE.has(w) && w !== "&");
  return words.slice(0, KEY_WORDS).join(" ");
}

/**
 * Words a bank uses for how money moved, never for who it went to: with numbers dropped, "CHECK
 * 1041" and "CHECK 1042" are one key, "MOBILE DEPOSIT" is `mobile`, "WIRE TRANSFER OUT" is
 * `wire out`.
 */
const GENERIC = new Set([
  ...NOISE,
  "check",
  "chk",
  "cheque",
  "mobile",
  "remote",
  "atm",
  "wire",
  "zelle",
  "venmo",
  "paypal",
  "cash",
  "app",
  "ach",
  "eft",
  "electronic",
  "bill",
  "pay",
  "pymt",
  "draft",
  "branch",
  "teller",
  "counter",
  "in",
  "out",
  "to",
  "from",
  "for",
  "of",
  "the",
  "no",
  "banking",
  "bank",
  "external",
  "internal",
  "outgoing",
  "incoming",
  "domestic",
  "international",
  "funds",
  "instant",
  "inst",
]);

// DECISION: a key made only of such words names no payee, so no rule is learned, written or
// applied for it (a rule `check → Rent` would book every check, whoever it paid); a person decides
// each one. An empty key is generic too.
export function isGenericPayeeKey(key: string | null | undefined): boolean {
  const words = (key ?? "").split(/\s+/).filter((w) => w.length > 0);
  return words.every((w) => GENERIC.has(w));
}
