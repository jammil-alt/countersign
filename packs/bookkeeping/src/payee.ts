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
