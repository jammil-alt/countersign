// Card numbers (PCI DSS 3.3, 3.4; docs/plan.md §1.35): Mezonas never takes card data, but a number
// can arrive in a document, a text or an email. Before such text is stored or sent to error
// tracking, any 13–19 digit run (spaces or dashes allowed between digits) that passes the Luhn
// check becomes `[card ending 1234]`.

// A digit, then 12–18 more each optionally after one space or dash; not inside a longer number.
const CANDIDATE = /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d])/g;

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
}

// DECISION: a run of one repeated digit (0000 0000 0000 0000) passes Luhn but is filler, not a
// card; it is left alone so totals and ids padded with zeros are not mangled.
function looksLikeCard(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  if (/^(\d)\1+$/.test(digits)) return false;
  return luhnValid(digits);
}

export function redactCardNumbers(text: string): string {
  if (!/\d{4}/.test(text) && !/\d[ -]\d/.test(text)) return text;
  return text.replace(CANDIDATE, (match) => {
    const digits = match.replace(/[ -]/g, "");
    return looksLikeCard(digits) ? `[card ending ${digits.slice(-4)}]` : match;
  });
}

/** Every string in a JSON value, redacted; other values as they are. */
export function redactCardNumbersDeep<T>(value: T): T {
  if (typeof value === "string") return redactCardNumbers(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactCardNumbersDeep(v)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactCardNumbersDeep(v);
    }
    return out as T;
  }
  return value;
}
