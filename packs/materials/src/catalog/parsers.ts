// Step 3 of item matching (ARCHITECTURE §12.3): attributes from a normalized description, by
// category parser (rules and unit tables). Each category declares its **key attributes**: two
// lines are the same item only if every key attribute they both state is equal, and the hard
// rules veto any match where one differs. Sheet goods, hardwood and hardware are parsed fully;
// mouldings/edgebanding and finishes/adhesives are basic, and fall back to the model when their
// required attributes are missing (./model.ts).

import type { Category, StandardUom } from "../schema";
import { findSheetSize, findThickness, formatMm, nominalThickness, toMm } from "./units";

/** Attribute values are lowercase strings; an attribute nobody stated is absent. */
export type Attributes = Record<string, string>;

export interface CategorySpec {
  category: Category;
  /** Key attributes, in signature order. */
  keys: readonly string[];
  /** Key attributes both sides must state before a match can be automatic. */
  required(attributes: Attributes): readonly string[];
  standardUom(attributes: Attributes): StandardUom;
  /** The catalog's name for an item with these attributes. */
  name(attributes: Attributes): string;
  parse(text: string, tokens: readonly string[]): Attributes;
}

type Vocabulary = readonly (readonly [RegExp, string])[];

/** The value of the first entry whose pattern occurs in the text. */
function first(text: string, vocabulary: Vocabulary): string | undefined {
  for (const [pattern, value] of vocabulary) if (pattern.test(text)) return value;
  return undefined;
}

const w = (words: string) => new RegExp(`(?:^|\\s)(?:${words})(?=\\s|$)`);

const SPECIES: Vocabulary = [
  [w("BALTIC BIRCH|BIRCH BALTIC|BALTIC"), "baltic_birch"],
  [w("RED OAK"), "red_oak"],
  [w("WHITE OAK"), "white_oak"],
  [w("HARD MAPLE"), "hard_maple"],
  [w("SOFT MAPLE"), "soft_maple"],
  [w("WHITE MAPLE|MAPLE"), "maple"],
  [w("BLACK WALNUT|WALNUT"), "walnut"],
  [w("CHERRY"), "cherry"],
  [w("POPLAR"), "poplar"],
  [w("HICKORY"), "hickory"],
  [w("ALDER"), "alder"],
  [w("ASH"), "ash"],
  [w("SAPELE"), "sapele"],
  [w("MAHOGANY"), "mahogany"],
  [w("WHITE BIRCH|BIRCH"), "birch"],
  [w("BEECH"), "beech"],
  [w("CEDAR"), "cedar"],
  [w("CYPRESS"), "cypress"],
  [w("BASSWOOD"), "basswood"],
  [w("TEAK"), "teak"],
  [w("LAUAN|MERANTI"), "lauan"],
  [w("PINE"), "pine"],
  [w("FIR"), "fir"],
  [w("OAK"), "oak"],
];

const COLOURS: Vocabulary = [
  [w("WHITE|WHT"), "white"],
  [w("BLACK"), "black"],
  [w("ALMOND"), "almond"],
  [w("GREY|GRAY"), "grey"],
  [w("NATURAL"), "natural"],
];

// ── Sheet goods ──────────────────────────────────────────────────────────────────────────────────

const SHEET_GRADE = /(?:^|\s)((?:BB|CP|WG|[A-D])\/(?:BB|CP|WG|[A-D1-4]))(?=\s|$)/;
const SHEET_GRADE_SHORT = /(?:^|\s)([A-D])-?([1-4])(?=\s|$)/;

const SHEET_MATERIAL: Vocabulary = [
  [w("MELAMINE|THERMOFUSED"), "melamine"],
  [w("HARDBOARD"), "hardboard"],
  [w("OSB"), "osb"],
];

const SHEET_CORE: Vocabulary = [
  [w("VENEER-CORE"), "veneer"],
  [w("MDF-CORE"), "mdf"],
  [w("PARTICLEBOARD-CORE"), "particleboard"],
  [w("COMBI-CORE"), "combi"],
  [w("ULTRALIGHT|ULTRA-LIGHT"), "ultralight"],
];

const SHEET_SPEC: Vocabulary = [
  [w("FR"), "fire_rated"],
  [w("MR"), "moisture_resistant"],
  [w("NAUF|NAF"), "nauf"],
  [w("MARINE"), "marine"],
  [w("EXTERIOR|EXT"), "exterior"],
];

const CUT: Vocabulary = [
  [w("RIFT"), "rift"],
  [w("QUARTERED"), "quartered"],
  [w("ROTARY"), "rotary"],
];

export const sheetGoods: CategorySpec = {
  category: "sheet_goods",
  keys: ["material", "face", "core", "thickness", "size", "grade", "finish", "cut", "spec"],
  required: (a) =>
    a.material === "plywood"
      ? ["material", "face", "thickness", "size"]
      : ["material", "thickness", "size"],
  standardUom: () => "sheet",
  name(a) {
    const face = a.face && a.face !== "none" ? `${label(a.face)} ` : "";
    const parts = [
      `${face}${label(a.material ?? "sheet")}`,
      a.thickness,
      a.size,
      a.grade && a.grade !== "none" ? a.grade.toUpperCase() : undefined,
      a.core && !["none", "all_ply"].includes(a.core) ? `${label(a.core)} core` : undefined,
      a.cut && !["plain", "none"].includes(a.cut) && a.face !== "baltic_birch"
        ? label(a.cut)
        : undefined,
      a.finish === "prefinished" || a.finish === "primed" ? label(a.finish) : undefined,
      a.spec && a.spec !== "standard" ? label(a.spec) : undefined,
    ];
    return sentence(parts);
  },
  parse(text, tokens) {
    const a: Attributes = {};
    const species = first(text, SPECIES);
    const explicit = first(text, SHEET_MATERIAL);
    const plywood = w("PLYWOOD").test(text);
    const mdf = w("MDF").test(text);
    const pb = w("PARTICLEBOARD").test(text);
    if (explicit === "melamine") a.material = "melamine";
    else if (plywood || (species && !mdf && !pb && !explicit)) a.material = "plywood";
    else if (explicit) a.material = explicit;
    else if (mdf) a.material = "mdf";
    else if (pb) a.material = "particleboard";

    if (a.material === "plywood") {
      if (species) a.face = species;
      a.core = first(text, SHEET_CORE) ?? (species === "baltic_birch" ? "all_ply" : "");
      if (!a.core) delete a.core;
      const grade = SHEET_GRADE.exec(text) ?? null;
      const short = grade ? null : SHEET_GRADE_SHORT.exec(text);
      if (grade?.[1]) a.grade = grade[1].toLowerCase();
      else if (short) a.grade = `${short[1]}${short[2]}`.toLowerCase();
      else if (w("SHOP").test(text)) a.grade = "shop";
      a.cut = species === "baltic_birch" ? "rotary" : (first(text, CUT) ?? "plain");
    } else if (a.material === "melamine") {
      a.face = first(text, COLOURS) ?? (species ? species : "");
      if (!a.face) delete a.face;
      if (w("MDF|MDF-CORE").test(text)) a.core = "mdf";
      else if (w("PARTICLEBOARD|PARTICLEBOARD-CORE").test(text)) a.core = "particleboard";
      a.grade = "none";
      a.cut = "none";
    } else if (a.material) {
      a.face = "none";
      a.core = "none";
      a.grade = "none";
      a.cut = "none";
    }
    if (a.material === "melamine") a.finish = "none";
    else if (w("PREFINISHED|UV|UV1S|UV2S|UV-1S|UV-2S").test(text)) a.finish = "prefinished";
    else if (w("PRIMED").test(text)) a.finish = "primed";
    else if (a.material) a.finish = "unfinished";
    if (a.material) a.spec = first(text, SHEET_SPEC) ?? "standard";

    const size = findSheetSize(tokens);
    if (size) a.size = size.size;
    const thickness =
      size?.thicknessInches != null
        ? nominalThickness(size.thicknessInches)
        : (findThickness(tokens)?.thickness.nominal ?? null);
    const measured = size?.thicknessInches != null ? null : findThickness(tokens)?.thickness;
    if (thickness) a.thickness = thickness;
    if (measured) a.thickness_mm = measured.actualMm;
    else if (size?.thicknessInches != null) {
      a.thickness_mm = String(Math.round(size.thicknessInches * 254) / 10);
    }
    return a;
  },
};

// ── Hardwood lumber ──────────────────────────────────────────────────────────────────────────────

const HARDWOOD_GRADE: Vocabulary = [
  [w("SEL&BTR"), "sel_btr"],
  [w("FAS"), "fas"],
  [w("F1F|FAS1F|FAS/1F"), "f1f"],
  [w("SELECT"), "select"],
  [w("#1C"), "1c"],
  [w("#2C"), "2c"],
  [w("#3C"), "3c"],
  [w("CLEAR"), "clear"],
  [w("PAINT-GRADE|PAINT"), "paint"],
];

const SURFACING: Vocabulary = [
  [w("S4S"), "s4s"],
  [w("S3S"), "s3s"],
  [w("S2S1E|SL1E|SLR1E|S2S/SL1E|S2S-SL1E|SLR"), "s2s1e"],
  [w("S2S"), "s2s"],
  [w("ROUGH"), "rough"],
];

export const hardwood: CategorySpec = {
  category: "hardwood",
  keys: ["species", "thickness", "grade", "surfacing", "cut"],
  required: () => ["species", "thickness"],
  standardUom: () => "board_foot",
  name(a) {
    return sentence([
      a.species ? label(a.species) : "Hardwood",
      a.thickness,
      a.grade ? a.grade.toUpperCase().replace("_", " & ") : undefined,
      a.surfacing ? (a.surfacing === "rough" ? "rough" : a.surfacing.toUpperCase()) : undefined,
      a.cut && a.cut !== "plain" ? label(a.cut) : undefined,
    ]);
  },
  parse(text) {
    const a: Attributes = {};
    const species = first(text, SPECIES);
    if (species) a.species = species;
    const quarters = /(?:^|\s)(\d{1,2})\/4(?:"|IN)?(?=\s|$)/.exec(text);
    if (quarters?.[1] && Number(quarters[1]) >= 4 && Number(quarters[1]) <= 16) {
      a.thickness = `${Number(quarters[1])}/4`;
    }
    const grade = first(text, HARDWOOD_GRADE);
    if (grade) a.grade = grade;
    // DECISION: lumber nobody calls surfaced is rough, as yards sell it.
    a.surfacing = first(text, SURFACING) ?? "rough";
    a.cut = first(text, CUT) ?? "plain";
    return a;
  },
};

// ── Hardware ─────────────────────────────────────────────────────────────────────────────────────

const BRANDS: Vocabulary = [
  [w("BLUM"), "blum"],
  [w("SALICE"), "salice"],
  [w("HETTICH"), "hettich"],
  [w("GRASS"), "grass"],
  [w("ACCURIDE"), "accuride"],
  [w("KNAPE-VOGT"), "knape_vogt"],
  [w("KING-SLIDE"), "king_slide"],
  [w("HAFELE|HÄFELE"), "hafele"],
  [w("RICHELIEU"), "richelieu"],
  [w("AMEROCK"), "amerock"],
  [w("TOP-KNOBS"), "top_knobs"],
  [w("SUGATSUNE"), "sugatsune"],
  [w("KREG"), "kreg"],
  [w("SPAX"), "spax"],
  [w("GRK"), "grk"],
  [w("FASTCAP"), "fastcap"],
  [w("SOSS"), "soss"],
];

const HARDWARE_KIND: Vocabulary = [
  [w("HINGE"), "hinge"],
  [w("SLIDE|SLIDE-SET|RUNNER"), "slide"],
  [w("PULL"), "pull"],
  [w("KNOB"), "knob"],
  [w("SCREW"), "screw"],
  [w("BRACKET"), "bracket"],
  [w("PLATE|MOUNTING-PLATE"), "plate"],
  [w("LOCK"), "lock"],
  [w("CATCH"), "catch"],
  [w("LEG"), "leg"],
  [w("DAMPER|BUMPER"), "damper"],
];

const HARDWARE_FINISH: Vocabulary = [
  [w("SATIN NICKEL"), "satin_nickel"],
  [w("BRUSHED NICKEL"), "brushed_nickel"],
  [w("POLISHED NICKEL"), "polished_nickel"],
  [w("NICKEL|NP|NICKEL-PLATED"), "nickel"],
  [w("MATTE BLACK|FLAT BLACK"), "matte_black"],
  [w("BLACK"), "black"],
  [w("POLISHED CHROME"), "polished_chrome"],
  [w("CHROME"), "chrome"],
  [w("OIL RUBBED BRONZE"), "oil_rubbed_bronze"],
  [w("CHAMPAGNE BRONZE"), "champagne_bronze"],
  [w("BRONZE"), "bronze"],
  [w("BRASS"), "brass"],
  [w("STAINLESS"), "stainless"],
  [w("ZINC|ZP"), "zinc"],
  [w("WHITE"), "white"],
  [w("GOLD"), "gold"],
];

/** Tokens that are quantities or units, never a model number. */
const NOT_A_MODEL = [
  /^\d+(?:PK|PC|PCS|CT|IN|MM|FT|LB|"|')$/,
  /^(?:BX|BOX|PK|CS|CTN)\/\d+$/,
  /^\d+\/(?:BX|BOX|PK|CS|CTN|PR)$/,
  /^(?:\d+-)?\d+\/\d+(?:"|IN)?$/,
  /^#\d+$/,
  /^\d{1,2}$/,
];

export const hardware: CategorySpec = {
  category: "hardware",
  keys: ["brand", "model", "finish", "size"],
  required: () => ["model"],
  standardUom: () => "each",
  name(a) {
    return sentence([
      a.brand ? label(a.brand) : undefined,
      a.kind ?? undefined,
      a.model ? a.model.toUpperCase() : undefined,
      a.size,
      a.finish ? label(a.finish) : undefined,
    ]);
  },
  parse(text, tokens) {
    const a: Attributes = {};
    const brand = first(text, BRANDS);
    if (brand) a.brand = brand;
    const kind = first(text, HARDWARE_KIND);
    if (kind) a.kind = kind;
    // DECISION: the model is the first token mixing letters and digits (`71B3550`), else the first
    // run of four or more digits (`3832`), else the first other numeric token; an angle
    // (`110 DEG`) or a quantity never is.
    const candidates = tokens.filter(
      (token, i) =>
        /\d/.test(token) &&
        token.length >= 3 &&
        !NOT_A_MODEL.some((p) => p.test(token)) &&
        !/^(?:DEG|DEGREE|DEGREES|°)$/.test(tokens[i + 1] ?? "") &&
        !/DEG$|°$/.test(token),
    );
    const model =
      candidates.find((t) => /[A-Z]/.test(t) && /^[A-Z0-9][A-Z0-9.\-/]*$/.test(t)) ??
      candidates.find((t) => /^\d{4,}(?:-\d+)?$/.test(t)) ??
      candidates[0];
    if (model) a.model = model.replace(/[^A-Z0-9]/g, "").toLowerCase();
    const finish = first(text, HARDWARE_FINISH);
    if (finish) a.finish = finish;
    const size = /(?:^|\s)(\d+(?:\.\d+)?)(?:"|IN)(?=\s|$)/.exec(text);
    const mm = /(?:^|\s)(\d{2,4})MM(?=\s|$)/.exec(text);
    if (size?.[1]) a.size = `${Number(size[1])}in`;
    else if (mm?.[1]) a.size = `${Number(mm[1])}mm`;
    const pack =
      /(?:^|\s)(?:BX|BOX|PK|CS|CTN)\/(\d+)(?=\s|$)/.exec(text) ??
      /(?:^|\s)(\d+)\/(?:BX|BOX|PK|CS|CTN)(?=\s|$)/.exec(text) ??
      /(?:^|\s)(\d+)(?:PK|PC|PCS|CT)(?=\s|$)/.exec(text) ??
      /(?:^|\s)BOX OF (\d+)(?=\s|$)/.exec(text);
    // Pack size converts the unit (M8b's pricing); it is not a key attribute.
    if (pack?.[1]) a.pack_size = String(Number(pack[1]));
    else if (w("PR|PAIR").test(text)) a.pack_size = "2";
    return a;
  },
};

// ── Mouldings and edgebanding (basic) ────────────────────────────────────────────────────────────

const PROFILES: Vocabulary = [
  [w("CROWN"), "crown"],
  [w("BASE|BASEBOARD"), "base"],
  [w("CASING"), "casing"],
  [w("SHOE"), "shoe"],
  [w("COVE"), "cove"],
  [w("QUARTER-ROUND"), "quarter_round"],
  [w("CHAIR-RAIL"), "chair_rail"],
  [w("LIGHT-RAIL"), "light_rail"],
  [w("SCRIBE"), "scribe"],
  [w("BATTEN"), "batten"],
];

const BAND_MATERIAL: Vocabulary = [
  [w("PVC"), "pvc"],
  [w("ABS"), "abs"],
  [w("MELAMINE"), "melamine"],
  [w("POLYESTER"), "polyester"],
  [w("VENEER|WOOD"), "veneer"],
];

export const mouldings: CategorySpec = {
  category: "mouldings",
  keys: ["kind", "material", "face", "width", "thickness", "profile"],
  required: (a) => (a.kind === "edgebanding" ? ["kind", "width"] : ["kind", "profile"]),
  standardUom: () => "linear_foot",
  name(a) {
    return sentence([
      a.face ? label(a.face) : undefined,
      a.material ? a.material.toUpperCase() : undefined,
      a.kind === "edgebanding" ? "edgebanding" : a.profile ? label(a.profile) : "moulding",
      a.width,
      a.thickness,
    ]);
  },
  parse(text, tokens) {
    const a: Attributes = {};
    a.kind = w("EDGEBANDING").test(text) ? "edgebanding" : "moulding";
    const species = first(text, SPECIES);
    const colour = first(text, COLOURS);
    if (a.kind === "edgebanding") {
      const material = first(text, BAND_MATERIAL);
      a.material = material ?? (species ? "veneer" : "");
      if (!a.material) delete a.material;
      const face = species ?? colour;
      if (face) a.face = face;
      const dims: number[] = [];
      for (const token of tokens.flatMap((t) => t.split("X"))) {
        const mm = toMm(token);
        if (mm !== null && mm > 0) dims.push(mm);
      }
      const width = dims.find((d) => d >= 10 && d <= 100);
      const thickness = dims.find((d) => d < 4);
      if (width !== undefined) a.width = `${Math.round(width)}mm`;
      if (thickness !== undefined) a.thickness = formatMm(thickness);
    } else {
      const code = /(?:^|\s)(WM\d+|#\d{2,4}|[A-Z]{1,3}-\d{2,4})(?=\s|$)/.exec(text);
      const profile = first(text, PROFILES);
      if (code?.[1]) a.profile = code[1].replace(/[^A-Z0-9]/g, "").toLowerCase();
      else if (profile) a.profile = profile;
      if (w("MDF").test(text)) a.material = "mdf";
      else if (w("PVC|POLYSTYRENE").test(text)) a.material = "pvc";
      else if (species) a.material = species;
      const dims =
        /(?:^|\s)((?:\d+-)?\d+\/\d+|\d*\.?\d+)(?:"|IN)?X((?:\d+-)?\d+\/\d+|\d*\.?\d+)(?:"|IN)?(?=\s|$)/.exec(
          text,
        );
      if (dims?.[1] && dims[2]) {
        const t = toMm(dims[1]);
        const wd = toMm(dims[2]);
        if (t !== null && wd !== null) {
          a.thickness = `${Math.round(Math.min(t, wd))}mm`;
          a.width = `${Math.round(Math.max(t, wd))}mm`;
        }
      }
    }
    const roll = /(?:^|\s)(\d+)(?:FT|'|LF)(?=\s|$)/.exec(text);
    if (roll?.[1]) a.length_ft = String(Number(roll[1]));
    return a;
  },
};

// ── Finishes and adhesives (basic) ───────────────────────────────────────────────────────────────

const FINISH_BRANDS: Vocabulary = [
  [w("TITEBOND"), "titebond"],
  [w("GORILLA"), "gorilla"],
  [w("3M"), "3m"],
  [w("WILSONART"), "wilsonart"],
  [w("LOCTITE"), "loctite"],
  [w("WELDWOOD|DAP"), "dap"],
  [w("SHERWIN-WILLIAMS"), "sherwin_williams"],
  [w("ML-CAMPBELL"), "ml_campbell"],
  [w("CHEMCRAFT"), "chemcraft"],
  [w("GEMINI"), "gemini"],
  [w("MOHAWK"), "mohawk"],
  [w("GENERAL-FINISHES"), "general_finishes"],
  [w("MINWAX"), "minwax"],
  [w("RENNER"), "renner"],
  [w("SAYERLACK"), "sayerlack"],
  [w("BENJAMIN-MOORE"), "benjamin_moore"],
  [w("ZINSSER"), "zinsser"],
  [w("VALSPAR"), "valspar"],
];

const ADHESIVE_WORDS = w(
  "GLUE|ADHESIVE|CONTACT-CEMENT|CONTACT|PVA|EPOXY|CA|HOT-MELT|HOTMELT|CAULK|CONSTRUCTION",
);
const FINISH_WORDS = w(
  "LACQUER|VARNISH|STAIN|POLYURETHANE|PAINT|PRIMER|SEALER|TOPCOAT|CONVERSION|PRECAT|PRE-CAT|POSTCAT|POST-CAT|OIL|WAX|DYE|TONER|GLAZE|REDUCER|THINNER|CATALYST|SHELLAC",
);

const SHEEN: Vocabulary = [
  [w("SEMI-GLOSS"), "semi_gloss"],
  [w("GLOSS"), "gloss"],
  [w("SATIN"), "satin"],
  [w("EGGSHELL"), "eggshell"],
  [w("MATTE|MATT"), "matte"],
  [w("FLAT"), "flat"],
  [w("DULL"), "dull"],
];

const CONTAINER = /(?:^|\s)(\d*\.?\d+)?(GALLON|QUART|PINT|OZ|LITER|L)(?=\s|$)/;
const ROMAN: Record<string, string> = { II: "2", III: "3", IV: "4" };
/** Words that say what kind of thing it is, not which product line. */
const FINISH_STOP = new Set([
  "WOOD",
  "GLUE",
  "ADHESIVE",
  "CAN",
  "PAIL",
  "DRUM",
  "TUBE",
  "BOTTLE",
  "EA",
  "EACH",
  "CASE",
  "THE",
  "FOR",
  "WITH",
  "AND",
  "OF",
  "SHEEN",
  "FINISH",
  "COAT",
]);

export const finishes: CategorySpec = {
  category: "finishes",
  keys: ["kind", "brand", "product", "sheen"],
  required: () => ["brand", "product"],
  standardUom: (a) => (a.container_unit === "each" ? "each" : "gallon"),
  name(a) {
    return sentence([
      a.brand ? label(a.brand) : undefined,
      a.product ? a.product.toUpperCase() : undefined,
      a.sheen ? label(a.sheen) : undefined,
      a.kind,
    ]);
  },
  parse(text, tokens) {
    const a: Attributes = {};
    a.kind = ADHESIVE_WORDS.test(text) ? "adhesive" : FINISH_WORDS.test(text) ? "finish" : "";
    if (!a.kind) delete a.kind;
    const brand = first(text, FINISH_BRANDS);
    if (brand) a.brand = brand;
    const numeric = /(?:^|\s)(\d{1,3})(?:SH|SHEEN)(?=\s|$)/.exec(text);
    const sheen = numeric?.[1] ? `${Number(numeric[1])}_sheen` : first(text, SHEEN);
    if (sheen) a.sheen = sheen;
    const container = CONTAINER.exec(text);
    if (container?.[2]) {
      a.container = `${container[1] ?? "1"} ${container[2].toLowerCase()}`;
    } else if (w("TUBE|CARTRIDGE|BOTTLE|CAN").test(text)) {
      a.container_unit = "each";
    }
    const brandPattern = brand ? FINISH_BRANDS.find(([, v]) => v === brand)?.[0] : undefined;
    const product: string[] = [];
    for (const token of tokens) {
      if (brandPattern?.test(` ${token} `.trim())) continue;
      if (ADHESIVE_WORDS.test(token) || FINISH_WORDS.test(token)) continue;
      if (first(token, SHEEN) || /^\d{1,3}(?:SH|SHEEN)$/.test(token)) continue;
      // Bare numbers stay: they name product lines (`3M 77`, `TITEBOND 2`).
      if (CONTAINER.test(token) || FINISH_STOP.has(token)) continue;
      product.push(ROMAN[token] ?? token);
    }
    if (product.length > 0) a.product = product.join(" ").toLowerCase();
    return a;
  },
};

// ── Everything else ──────────────────────────────────────────────────────────────────────────────

export const other: CategorySpec = {
  category: "other",
  keys: ["description"],
  required: () => ["description"],
  standardUom: () => "each",
  name: (a) => sentence([a.description]),
  // DECISION: `other` lines are never matched by rules (their one key attribute is never parsed);
  // the model or a person decides them.
  parse: () => ({}),
};

export const CATEGORY_SPECS: Readonly<Record<Category, CategorySpec>> = {
  sheet_goods: sheetGoods,
  hardwood,
  mouldings,
  hardware,
  finishes,
  other,
};

/** Which parser reads a description: the most specific signal wins. */
export function detectCategory(text: string): Category {
  if (w("EDGEBANDING").test(text) || first(text, PROFILES) || /(?:^|\s)WM\d+(?=\s|$)/.test(text)) {
    return "mouldings";
  }
  if (first(text, BRANDS) || first(text, HARDWARE_KIND)) return "hardware";
  if (first(text, FINISH_BRANDS) || ADHESIVE_WORDS.test(text) || FINISH_WORDS.test(text)) {
    return "finishes";
  }
  const sheet = w("PLYWOOD|MDF|PARTICLEBOARD|MELAMINE|HARDBOARD|OSB|SHEET|BALTIC").test(text);
  const quarters = /(?:^|\s)(?:[4-9]|1[0-6])\/4(?:"|IN)?(?=\s|$)/.test(text);
  const lumber = w("BF|LUMBER|FAS|F1F|S2S|S3S|S4S|ROUGH|SEL&BTR|#1C|#2C|S2S1E|SL1E").test(text);
  if (!sheet && (quarters || lumber) && first(text, SPECIES)) return "hardwood";
  if (sheet) return "sheet_goods";
  if (first(text, SPECIES) && findSheetSize(text.split(" "))) return "sheet_goods";
  return "other";
}

function label(value: string): string {
  return value.replace(/_/g, " ");
}

function sentence(parts: readonly (string | undefined)[]): string {
  const text = parts.filter((p): p is string => Boolean(p)).join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
