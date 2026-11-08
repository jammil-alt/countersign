// P-7: which of the six languages a message is in (docs/plan.md §1.69), in code, before any model.
//
// No regular expression ever runs over the text: letters are classified one code point at a time,
// words are cut at non-letters by a plain loop, and each language is scored by the common words and
// letters it has. A text in another script (Japanese, Arabic, Cyrillic…) is `unknown`: it is outside
// the six, so it is never guessed. When the code isn't sure, the translation call names the source
// language itself (one call, never a separate one).

import { LOCALES, type Locale } from "../i18n/locale";

export type DetectedLanguage = Locale | "unknown";

export interface Detection {
  language: DetectedLanguage;
  /**
   * `sure`: trusted without a model; `likely`: a hint for the model; `unsure`: the model decides.
   * A text mostly in another script is `unknown` and `sure`.
   */
  confidence: "sure" | "likely" | "unsure";
  /** Letters counted (any script). Fewer than MIN_LETTERS: nothing to translate. */
  letters: number;
}

/** Fewer letters than this ("ok", "👍", "1") is not worth a translation. */
export const MIN_LETTERS = 3;

// Common short words, lower case, without their accents where people often drop them. A word in
// several lists scores a share in each, so `de` or `la` decide little and `the`, `und`, `obrigado`
// decide much.
const WORDS: Record<Locale, readonly string[]> = {
  en: [
    "the",
    "and",
    "is",
    "are",
    "you",
    "your",
    "we",
    "our",
    "to",
    "of",
    "for",
    "with",
    "this",
    "that",
    "will",
    "can",
    "please",
    "thanks",
    "thank",
    "have",
    "has",
    "not",
    "it",
    "be",
    "on",
    "at",
    "from",
    "what",
    "when",
    "how",
    "hi",
    "hello",
    "need",
    "would",
    "could",
    "tomorrow",
    "today",
    "yes",
    "send",
    "know",
    "just",
    "they",
    "there",
  ],
  es: [
    "el",
    "la",
    "los",
    "las",
    "de",
    "que",
    "y",
    "en",
    "un",
    "una",
    "es",
    "por",
    "para",
    "con",
    "no",
    "su",
    "gracias",
    "hola",
    "usted",
    "esta",
    "está",
    "muy",
    "pero",
    "si",
    "sí",
    "cuando",
    "qué",
    "como",
    "cómo",
    "necesito",
    "favor",
    "buenos",
    "buenas",
    "dias",
    "días",
    "mañana",
    "tambien",
    "también",
    "hoy",
    "nosotros",
    "estoy",
    "puede",
    "quiero",
    "del",
    "al",
    "lo",
  ],
  fr: [
    "le",
    "la",
    "les",
    "des",
    "du",
    "et",
    "est",
    "pour",
    "avec",
    "vous",
    "nous",
    "je",
    "pas",
    "une",
    "un",
    "merci",
    "bonjour",
    "sur",
    "dans",
    "que",
    "qui",
    "mais",
    "très",
    "oui",
    "avez",
    "sont",
    "demain",
    "aujourd",
    "hui",
    "votre",
    "notre",
    "ce",
    "cette",
    "bien",
    "au",
    "aux",
    "suis",
    "peux",
    "pouvez",
    "besoin",
  ],
  "pt-BR": [
    "o",
    "a",
    "os",
    "as",
    "de",
    "que",
    "e",
    "em",
    "um",
    "uma",
    "não",
    "nao",
    "para",
    "com",
    "obrigado",
    "obrigada",
    "você",
    "voce",
    "está",
    "por",
    "favor",
    "mais",
    "muito",
    "olá",
    "ola",
    "bom",
    "dia",
    "também",
    "são",
    "sim",
    "mas",
    "amanhã",
    "hoje",
    "preciso",
    "do",
    "da",
    "dos",
    "das",
    "no",
    "na",
    "eu",
    "vocês",
  ],
  it: [
    "il",
    "lo",
    "la",
    "gli",
    "le",
    "di",
    "che",
    "e",
    "è",
    "un",
    "una",
    "per",
    "con",
    "non",
    "grazie",
    "ciao",
    "sono",
    "molto",
    "ma",
    "anche",
    "buongiorno",
    "questo",
    "questa",
    "quando",
    "come",
    "sì",
    "domani",
    "oggi",
    "ho",
    "hai",
    "abbiamo",
    "del",
    "della",
    "nel",
    "alla",
    "prego",
    "vorrei",
    "posso",
  ],
  de: [
    "der",
    "die",
    "das",
    "und",
    "ist",
    "nicht",
    "ich",
    "sie",
    "wir",
    "mit",
    "für",
    "auf",
    "ein",
    "eine",
    "danke",
    "bitte",
    "hallo",
    "haben",
    "sind",
    "auch",
    "aber",
    "wie",
    "was",
    "guten",
    "tag",
    "morgen",
    "heute",
    "ja",
    "nein",
    "kann",
    "können",
    "den",
    "dem",
    "zu",
    "es",
    "noch",
    "brauche",
    "ihr",
    "ihre",
  ],
};

// Letters that point at a language (some at more than one), with how much each counts.
const MARKS: Record<string, readonly [Locale, number][]> = {
  ñ: [["es", 2]],
  "¿": [["es", 2]],
  "¡": [["es", 2]],
  ã: [["pt-BR", 2]],
  õ: [["pt-BR", 2]],
  ç: [
    ["fr", 1],
    ["pt-BR", 1],
  ],
  ß: [["de", 2]],
  ä: [["de", 1]],
  ö: [["de", 1]],
  ü: [["de", 1]],
  œ: [["fr", 2]],
  è: [
    ["fr", 0.5],
    ["it", 0.5],
  ],
  ì: [["it", 1]],
  ò: [["it", 1]],
  ù: [
    ["it", 0.5],
    ["fr", 0.5],
  ],
  â: [["fr", 1]],
  ê: [
    ["fr", 0.5],
    ["pt-BR", 0.5],
  ],
  î: [["fr", 1]],
  ô: [
    ["fr", 0.5],
    ["pt-BR", 0.5],
  ],
  û: [["fr", 1]],
};

/** Each word's score per language: a share when it is common to several. */
const WORD_SCORES: ReadonlyMap<string, readonly [Locale, number][]> = (() => {
  const seen = new Map<string, Locale[]>();
  for (const locale of LOCALES) {
    for (const w of WORDS[locale]) {
      const list = seen.get(w) ?? [];
      if (!list.includes(locale)) list.push(locale);
      seen.set(w, list);
    }
  }
  return new Map(
    [...seen].map(([w, ls]) => [w, ls.map((l): [Locale, number] => [l, 1 / ls.length])]),
  );
})();

type Kind = "latin" | "other" | "none";

/** Whether a code point is a letter, and of the Latin script (Basic Latin to Latin Extended-B). */
function kindOf(cp: number): Kind {
  if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) return "latin";
  if (cp < 0xc0) return "none";
  if (cp <= 0x24f) return cp === 0xd7 || cp === 0xf7 ? "none" : "latin";
  const ch = String.fromCodePoint(cp);
  // A single code point against a fixed property: no backtracking is possible.
  return ch.toLowerCase() !== ch.toUpperCase() || /\p{L}/u.test(ch) ? "other" : "none";
}

/** The language of `text`, by common words and letters (docs/plan.md §1.69). */
export function detectLanguage(text: string): Detection {
  const scores = Object.fromEntries(LOCALES.map((l) => [l, 0])) as Record<Locale, number>;
  let latin = 0;
  let other = 0;
  let words = 0;
  let word = "";
  const endWord = () => {
    if (!word) return;
    words += 1;
    for (const [l, s] of WORD_SCORES.get(word) ?? []) scores[l] += s;
    word = "";
  };
  for (const ch of text.toLowerCase()) {
    const cp = ch.codePointAt(0) ?? 0;
    const mark = MARKS[ch];
    if (mark) for (const [l, s] of mark) scores[l] += s;
    const kind = kindOf(cp);
    if (kind === "latin") {
      latin += 1;
      word += ch;
    } else {
      if (kind === "other") other += 1;
      endWord();
    }
  }
  endWord();
  const letters = latin + other;
  if (letters < MIN_LETTERS) return { language: "unknown", confidence: "unsure", letters };
  // Mostly another script: outside the six, never guessed.
  if (other > latin) return { language: "unknown", confidence: "sure", letters };
  const ranked = LOCALES.map((l) => [l, scores[l]] as const).sort((a, b) => b[1] - a[1]);
  const [best, next] = ranked;
  const top = best?.[1] ?? 0;
  const second = next?.[1] ?? 0;
  if (!best || top === 0) return { language: "unknown", confidence: "unsure", letters };
  // DECISION: sure at 3 points and twice the next language, over at least 3 words; a short or
  // mixed text goes to the model with the best guess as a hint.
  if (top >= 3 && top >= 2 * second && words >= 3) {
    return { language: best[0], confidence: "sure", letters };
  }
  return { language: best[0], confidence: top > second ? "likely" : "unsure", letters };
}
