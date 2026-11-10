// A phone number for sign-in codes (docs/plan.md §1.83): the person picks their own country and
// types the number as they know it; we turn it into E.164 with core's `normalizePhone`. A number
// that starts with + (or 00) keeps its own country code, whatever country is picked.
import { normalizePhone } from "@countersign/core";

/**
 * Countries and their calling codes, by ISO region code. The names come from Intl.DisplayNames in
 * the reader's language.
 */
// DECISION: a short list of the countries our clients and their people are likely in, not all of
// them; anyone else types the number with + and its country code, which the form says.
export const PHONE_COUNTRIES: Readonly<Record<string, string>> = {
  AD: "376",
  AE: "971",
  AO: "244",
  AR: "54",
  AT: "43",
  AU: "61",
  BE: "32",
  BG: "359",
  BO: "591",
  BR: "55",
  CA: "1",
  CH: "41",
  CL: "56",
  CN: "86",
  CO: "57",
  CR: "506",
  CV: "238",
  CY: "357",
  CZ: "420",
  DE: "49",
  DK: "45",
  DO: "1",
  EC: "593",
  EE: "372",
  EG: "20",
  ES: "34",
  FI: "358",
  FR: "33",
  GB: "44",
  GR: "30",
  GT: "502",
  HK: "852",
  HN: "504",
  HR: "385",
  HU: "36",
  ID: "62",
  IE: "353",
  IL: "972",
  IN: "91",
  IS: "354",
  IT: "39",
  JM: "1",
  JP: "81",
  KE: "254",
  KR: "82",
  LI: "423",
  LT: "370",
  LU: "352",
  LV: "371",
  MA: "212",
  MC: "377",
  MT: "356",
  MX: "52",
  MY: "60",
  MZ: "258",
  NG: "234",
  NI: "505",
  NL: "31",
  NO: "47",
  NZ: "64",
  PA: "507",
  PE: "51",
  PH: "63",
  PK: "92",
  PL: "48",
  PR: "1",
  PT: "351",
  PY: "595",
  RO: "40",
  RS: "381",
  SA: "966",
  SE: "46",
  SG: "65",
  SI: "386",
  SK: "421",
  SM: "378",
  SV: "503",
  TH: "66",
  TR: "90",
  TW: "886",
  UA: "380",
  US: "1",
  UY: "598",
  VN: "84",
  ZA: "27",
};

/** Countries whose numbers keep their leading 0 after the country code. */
const KEEPS_ZERO = new Set(["IT", "SM"]);

/**
 * What the person typed, in E.164, or null when it isn't a phone number. `country` is used only
 * when the number doesn't start with + or 00.
 */
// DECISION: a national number drops its one leading 0 (the trunk prefix: 07700 900123 in the UK
// is +44 7700 900123), except in Italy and San Marino; in the US and Canada a leading 1 is the
// country code typed again.
export function phoneToE164(raw: string, country: string): string | null {
  const typed = raw.trim();
  if (!typed) return null;
  if (/^(\+|00|whatsapp:)/i.test(typed)) return normalizePhone(typed);
  const dial = PHONE_COUNTRIES[country];
  if (!dial) return null;
  // Only digits and the separators people type; letters are never a phone number.
  if (!/^[\d\s().-]+$/.test(typed)) return null;
  let digits = typed.replace(/\D/g, "");
  if (dial === "1" && digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (dial === "1" && digits.length !== 10) return null;
  if (!KEEPS_ZERO.has(country) && digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length < 4) return null;
  return normalizePhone(`+${dial}${digits}`);
}

/** The person's own country, from the browser's languages (`en-GB` → GB), else the US. */
export function defaultPhoneCountry(languages: readonly string[]): string {
  for (const tag of languages) {
    try {
      const region = new Intl.Locale(tag).region;
      if (region && PHONE_COUNTRIES[region]) return region;
    } catch {
      // Not a language tag: skip it.
    }
  }
  return "US";
}

/** The countries as options, sorted by their name in `locale`: "Germany (+49)". */
export function phoneCountryOptions(locale: string): { code: string; label: string }[] {
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames([locale], { type: "region" });
  } catch {
    names = null;
  }
  const collator = new Intl.Collator(locale);
  return Object.entries(PHONE_COUNTRIES)
    .map(([code, dial]) => ({ code, name: names?.of(code) ?? code, dial }))
    .sort((a, b) => collator.compare(a.name, b.name))
    .map(({ code, name, dial }) => ({ code, label: `${name} (+${dial})` }));
}
