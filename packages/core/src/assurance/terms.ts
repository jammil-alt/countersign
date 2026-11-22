// What each AI provider of ours does with a client's data under its API terms
// (docs/agent-assurance-plan.md §4c gap 2, A0). Only what we have recorded from the provider's own
// terms; a field we haven't recorded is null and shows as "Not recorded yet", never guessed. The
// "No provider trains on your data" check is in review for a provider whose training is null.
//
// DECISION (A0): recorded by hand, reviewed like code, as the register is. The owner fills in
// retention and region from each provider's data processing terms; until then the client sees
// "Not recorded yet" and the check says so.

import type { Processor } from "../compliance/processors";

export type ProviderTerms = {
  /** "no": the provider's API terms exclude training on API inputs and outputs by default. */
  training: "no" | null;
  /** How long the provider keeps API inputs and outputs, in its terms' words. */
  retention: string | null;
  /** Where it processes them. */
  region: string | null;
};

const NOT_RECORDED: ProviderTerms = { training: null, retention: null, region: null };

export const PROVIDER_TERMS: Partial<Record<Processor, ProviderTerms>> = {
  // Anthropic's commercial terms: API inputs and outputs are not used to train models.
  anthropic: { training: "no", retention: null, region: null },
  // OpenAI's API data usage policy: API data is not used for training unless the customer opts in.
  openai: { training: "no", retention: null, region: null },
  xai: NOT_RECORDED,
  google: NOT_RECORDED,
};

export function providerTerms(p: Processor): ProviderTerms {
  return PROVIDER_TERMS[p] ?? NOT_RECORDED;
}
