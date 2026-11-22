// What each AI provider of ours does with a client's data under its API terms
// (docs/agent-assurance-plan.md §4c gap 2, A0; §1.231.1). Only what the provider's own public page
// says, in its words, briefly; a field a page doesn't settle is null and shows as "Not recorded
// yet", never guessed. The "No provider trains on your data" check is in review for a provider
// whose training is null.
//
// DECISION (A0): recorded by hand, reviewed like code, as the register is. Each entry cites the
// page it comes from; re-read them when a provider changes its terms. Read 2026-11-22.
// DECISION (§1.231.1): the terms of the products we call, as packages/llm calls them: Anthropic's
// API at api.anthropic.com with no `inference_geo`; OpenAI's API at api.openai.com, `store: false`,
// in a project without data residency; xAI's global endpoint, api.x.ai; Google's Gemini API at
// generativelanguage.googleapis.com on Mezonas' own key (not Vertex AI), as a Paid Service.

import type { Processor } from "../compliance/processors";

export type ProviderTerms = {
  /** "no": the provider's API terms exclude training on API inputs and outputs by default. */
  training: "no" | null;
  /** How long the provider keeps API inputs and outputs, in its terms' words. */
  retention: string | null;
  /** Where it processes them. */
  region: string | null;
  /** The pages the entry comes from, when each was checked and how it was read. */
  sources: TermsSource[];
};

export type TermsSource = {
  url: string;
  /** The day the entry was checked against this page (YYYY-MM-DD). */
  checked: string;
  /** "page": read on the page itself. "search-snippet": from a search result quoting the page,
   * because the page couldn't be opened from where it was recorded; to be read on the page. */
  read: "page" | "search-snippet";
};

const NOT_RECORDED: ProviderTerms = { training: null, retention: null, region: null, sources: [] };

// DECISION (§1.231.1): the pages couldn't be opened from the session that recorded them (its
// network allows none of these hosts), so every entry but Anthropic's region page is marked
// "search-snippet" and its text says it is not yet confirmed on the page. Re-read each page and
// set `read: "page"` with the day.
const snippet = (url: string): TermsSource => ({
  url,
  checked: "2026-11-22",
  read: "search-snippet",
});
const page = (url: string): TermsSource => ({ url, checked: "2026-11-22", read: "page" });

export const PROVIDER_TERMS: Partial<Record<Processor, ProviderTerms>> = {
  anthropic: {
    // Anthropic's commercial terms: API inputs and outputs are not used to train models.
    // https://privacy.claude.com/en/articles/7996866-is-my-data-used-for-model-training
    training: "no",
    // https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-commercial-api-data
    retention:
      "Deleted from its backend within 30 days of receipt or generation, unless kept longer by agreement, by law or to enforce its Usage Policy",
    // https://platform.claude.com/docs/en/manage-claude/data-residency
    region: "Any available geography (the default, global; we don't ask for US only)",
    sources: [
      snippet("https://privacy.claude.com/en/articles/7996866-is-my-data-used-for-model-training"),
      snippet(
        "https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-commercial-api-data",
      ),
      // Read on the page: "global" is the default; a workspace's `default_inference_geo` can
      // change it, and ours sets none.
      page("https://platform.claude.com/docs/en/manage-claude/data-residency"),
    ],
  },
  openai: {
    // https://developers.openai.com/api/docs/guides/your-data
    training: "no",
    // https://developers.openai.com/api/docs/guides/your-data (abuse monitoring logs; we send
    // `store: false`, so no application state is kept)
    retention:
      "Abuse monitoring logs, which may hold prompts and responses, kept up to 30 days by default",
    // https://developers.openai.com/api/docs/guides/data-residency: residency is a per-project
    // choice; the page doesn't say where a project without it is processed.
    region: null,
    sources: [
      snippet("https://developers.openai.com/api/docs/guides/your-data"),
      snippet("https://developers.openai.com/api/docs/guides/data-residency"),
    ],
  },
  xai: {
    // https://docs.x.ai/developers/faq/security
    training: "no",
    // https://docs.x.ai/developers/faq/security
    retention:
      "Requests and responses kept 30 days, encrypted at rest, for auditing suspected abuse or misuse, then deleted",
    // https://docs.x.ai/developers/regions
    region: "No processing region guaranteed on the global endpoint (api.x.ai), which we use",
    sources: [
      snippet("https://docs.x.ai/developers/faq/security"),
      snippet("https://docs.x.ai/developers/regions"),
    ],
  },
  google: {
    // Gemini API Additional Terms of Service, Paid Services (a Cloud project with active billing):
    // https://ai.google.dev/gemini-api/terms
    training: "no",
    // https://ai.google.dev/gemini-api/terms
    retention:
      "Prompts and responses logged for a limited period, only to detect Prohibited Use Policy violations and for required legal or regulatory disclosures",
    // https://ai.google.dev/gemini-api/terms
    region:
      "May be stored transiently or cached in any country where Google or its agents maintain facilities",
    sources: [snippet("https://ai.google.dev/gemini-api/terms")],
  },
};

export function providerTerms(p: Processor): ProviderTerms {
  return PROVIDER_TERMS[p] ?? NOT_RECORDED;
}

/** "Kept by the provider" in the AI section: its retention, then where, or "Not recorded yet". */
export function providerKeeps(p: Processor): string {
  const t = providerTerms(p);
  if (!t.retention && !t.region) return "Not recorded yet";
  const text = [
    t.retention ?? "How long: not recorded yet",
    `Where: ${t.region ?? "not recorded yet"}`,
  ]
    .join(". ")
    .concat(".");
  return termsConfirmed(p) ? text : `${text} Not yet confirmed on the provider's own page.`;
}

/** True when every page an entry cites was read on the page itself, not from a search result. */
export function termsConfirmed(p: Processor): boolean {
  const t = providerTerms(p);
  return t.sources.length > 0 && t.sources.every((s) => s.read === "page");
}

/** How the AI section and the architecture word a provider's training terms. A "no" read only from
 * a search result is never shown as settled: it reads "to be confirmed". */
export function trainingWords(p: Processor): string {
  if (providerTerms(p).training !== "no") return "training terms not recorded yet";
  return termsConfirmed(p)
    ? "no training"
    : "no training, to be confirmed on the provider's own page";
}
