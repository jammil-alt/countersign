// Step 1 of item matching (ARCHITECTURE §12.3): a vendor's raw description in one canonical
// spelling. Uppercase, punctuation noise gone, numbers joined to their units, and abbreviations
// expanded from a global dictionary plus the vendor's own (`vendor.ext.abbreviations`), so
// "3/4 BB PLY 4 X 8" and "3/4\" BALTIC BIRCH PLYWOOD 4X8" read the same. Pure: no I/O.

/** Whole tokens, after punctuation is cleaned. Grades like `BB/BB` are one token and stay. */
export const GLOBAL_ABBREVIATIONS: Readonly<Record<string, string>> = {
  BB: "BALTIC BIRCH",
  BALT: "BALTIC",
  MEL: "MELAMINE",
  TFM: "MELAMINE",
  PLY: "PLYWOOD",
  PLYWD: "PLYWOOD",
  PLYWOODS: "PLYWOOD",
  PB: "PARTICLEBOARD",
  PBD: "PARTICLEBOARD",
  HDBD: "HARDBOARD",
  MASONITE: "HARDBOARD",
  PF: "PREFINISHED",
  PREFIN: "PREFINISHED",
  "PRE-FIN": "PREFINISHED",
  "PRE-FINISHED": "PREFINISHED",
  UNFIN: "UNFINISHED",
  RO: "RED OAK",
  WO: "WHITE OAK",
  HM: "HARD MAPLE",
  SM: "SOFT MAPLE",
  WAL: "WALNUT",
  CHY: "CHERRY",
  CHER: "CHERRY",
  POP: "POPLAR",
  ALD: "ALDER",
  HIC: "HICKORY",
  MAH: "MAHOGANY",
  BIR: "BIRCH",
  MPL: "MAPLE",
  VC: "VENEER-CORE",
  MDFC: "MDF-CORE",
  PBC: "PARTICLEBOARD-CORE",
  EB: "EDGEBANDING",
  EDGEBAND: "EDGEBANDING",
  BANDING: "EDGEBANDING",
  BLK: "BLACK",
  WHT: "WHITE",
  WH: "WHITE",
  NKL: "NICKEL",
  NI: "NICKEL",
  SN: "SATIN NICKEL",
  BN: "BRUSHED NICKEL",
  PN: "POLISHED NICKEL",
  PC: "POLISHED CHROME",
  ORB: "OIL RUBBED BRONZE",
  MB: "MATTE BLACK",
  GAL: "GALLON",
  GL: "GALLON",
  QT: "QUART",
  SHT: "SHEET",
  SHTS: "SHEET",
  SHEETS: "SHEET",
  RGH: "ROUGH",
  QTR: "QUARTERED",
  QS: "QUARTERED",
  RFT: "RIFT",
  ROT: "ROTARY",
  RC: "ROTARY",
  PS: "PLAIN-SLICED",
  SEL: "SELECT",
  SELECTS: "SELECT",
  "1COM": "#1C",
  "2COM": "#2C",
  "1C": "#1C",
  "2C": "#2C",
  "#1COM": "#1C",
  "#2COM": "#2C",
  BDFT: "BF",
  FBM: "BF",
  "W/": "WITH",
  KV: "KNAPE-VOGT",
  HINGES: "HINGE",
  SLIDES: "SLIDE",
  PULLS: "PULL",
  KNOBS: "KNOB",
  SCREWS: "SCREW",
  LACQ: "LACQUER",
  POLY: "POLYURETHANE",
  ADH: "ADHESIVE",
};

/** Phrases joined into one token before the dictionary runs. */
const PHRASES: readonly [RegExp, string][] = [
  [/\bBOARD\s+F(?:EE|OO)T\b|\bBD\s*FT\b|\bB\.F\.?(?=\s|$)/g, "BF"],
  [/\bEDGE\s*BAND(?:ING)?\b/g, "EDGEBANDING"],
  [/\bPARTICLE\s*BOARD\b/g, "PARTICLEBOARD"],
  [/\bHARD\s*BOARD\b/g, "HARDBOARD"],
  [/\bVENEER\s+CORE\b/g, "VENEER-CORE"],
  [/\bMDF\s+CORE\b/g, "MDF-CORE"],
  [/\b(?:PB|PARTICLEBOARD)\s+CORE\b/g, "PARTICLEBOARD-CORE"],
  [/\bCOMBI(?:NATION)?\s+CORE\b|\bCOMBI\b/g, "COMBI-CORE"],
  [/\bPLAIN\s+SLICED?\b/g, "PLAIN-SLICED"],
  [/\bQUARTER(?:ED)?\s*SAWN\b/g, "QUARTERED"],
  [/\bRIFT\s*(?:SAWN|CUT)\b/g, "RIFT"],
  [/\bSEL(?:ECT)?\s*&\s*B(?:TR|ETTER)\b/g, "SEL&BTR"],
  [/\bNO\.?\s*1\s*COM(?:MON)?\b|#\s*1\s*COM(?:MON)?\b/g, "#1C"],
  [/\bNO\.?\s*2\s*COM(?:MON)?\b|#\s*2\s*COM(?:MON)?\b/g, "#2C"],
  [/\bKNAPE\s*(?:&|AND)\s*VOGT\b/g, "KNAPE-VOGT"],
  [/\bTOP\s+KNOBS\b/g, "TOP-KNOBS"],
  [/\bKING\s+SLIDE\b/g, "KING-SLIDE"],
  [/\bSHERWIN[\s-]*WILLIAMS\b/g, "SHERWIN-WILLIAMS"],
  [/\bM\.?\s?L\.?\s+CAMPBELL\b/g, "ML-CAMPBELL"],
  [/\bGENERAL\s+FINISHES\b/g, "GENERAL-FINISHES"],
  [/\bBENJAMIN\s+MOORE\b/g, "BENJAMIN-MOORE"],
  [/\bCONTACT\s+CEMENT\b/g, "CONTACT-CEMENT"],
  [/\bSEMI[\s-]*GLOSS\b/g, "SEMI-GLOSS"],
  [/\bHIGH\s+GLOSS\b/g, "GLOSS"],
  [/\bQUARTER\s+ROUND\b|\bQTR\s+ROUND\b/g, "QUARTER-ROUND"],
  [/\bCHAIR\s+RAIL\b/g, "CHAIR-RAIL"],
  [/\bLIGHT\s+RAIL\b/g, "LIGHT-RAIL"],
  [/\bFULL\s+EXT(?:ENSION)?\b/g, "FULL-EXT"],
  [/\bSOFT\s+CLOSE\b/g, "SOFT-CLOSE"],
  [/\bOIL\s+RUBBED\s+BRONZE\b/g, "OIL RUBBED BRONZE"],
  [/\bSTAINLESS(?:\s+STEEL)?\b/g, "STAINLESS"],
  [/\bFIRE\s+RATED\b/g, "FR"],
  [/\bMOISTURE\s+RESIST(?:ANT)?\b/g, "MR"],
  [/\bNO\s+ADDED\s+(?:UREA\s+)?FORMALDEHYDE\b/g, "NAUF"],
];

const UNITS = "MM|IN|FT|GALLON|GAL|QT|QUART|OZ|PK|PC|PCS|LF|BF|MIL|SH|SHEEN|PR";

export interface NormalizeOptions {
  /** Learned abbreviations for this client or vendor, applied over the global ones. */
  abbreviations?: Readonly<Record<string, string>>;
}

/** The canonical spelling of a vendor's description. Idempotent: normalize(normalize(x)) = normalize(x). */
export function normalize(raw: string, options: NormalizeOptions = {}): string {
  let s = raw
    .toUpperCase()
    .replace(/[″“”]|''/g, '"')
    .replace(/[′‘’`]/g, "'")
    .replace(/[×]/g, "X")
    .replace(/[,;:()[\]{}*!?|_~^=+<>]/g, " ")
    // "GAL." → "GAL", "BALT." → "BALT": an abbreviation's dot is noise (".75" keeps its own).
    .replace(/([A-Z])\.(?=\s|$)/g, "$1")
    // "4 X 8", "48 x 96", "4' X 8'": one size token.
    .replace(/(\d['"]?|\d(?:MM|IN|FT))\s*X\s*(?=\.?\d)/g, "$1X")
    // A number and its unit are one token: "18 MM" → "18MM", "5 GAL" → "5GAL".
    .replace(new RegExp(`(\\d)\\s+(${UNITS})(?=\\s|$|X)`, "g"), "$1$2")
    // "3/4 IN." → "3/4IN"; "0.75 IN" → "0.75IN".
    .replace(/(\d)\s+"/g, '$1"')
    .replace(/(\d)(?:GAL|GL)(?=\s|$)/g, "$1GALLON")
    .replace(/(\d)QT(?=\s|$)/g, "$1QUART");
  for (const [pattern, replacement] of PHRASES) s = s.replace(pattern, replacement);
  const dictionary = { ...GLOBAL_ABBREVIATIONS, ...upperKeys(options.abbreviations) };
  const tokens: string[] = [];
  for (const raw of s.split(/\s+/)) {
    // Trailing dots and stray dashes are noise ("PLY.", "-"); a leading dot is a decimal (".75").
    const token = raw.replace(/\.+$/, "").replace(/^-+|-+$/g, "");
    if (!token || token === "&" || token === "/" || token === "#") continue;
    const expanded = dictionary[token];
    tokens.push(expanded ?? token);
  }
  return tokens.join(" ").replace(/\s+/g, " ").trim();
}

function upperKeys(map: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map ?? {})) out[k.toUpperCase()] = v.toUpperCase();
  return out;
}

/** sha256 (hex) of the normalized description: the alias key (Web Crypto, Worker-safe). */
export async function descriptionHash(normalized: string): Promise<string> {
  const bytes = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
