// Onboarding v1 (docs/plan.md §1.125): the seams the wave's streams build in parallel. Until a
// stream lands, its routes answer 501 `not_built` and its functions throw this, naming the stream.

import { HttpError } from "../http";

/** The onboarding streams (docs/plan.md §1.125, "Streams"). */
export type OnboardingStream = "SALES" | "INTAKE" | "EMAIL";

export function notBuilt(stream: OnboardingStream, what: string): HttpError {
  return new HttpError(
    501,
    "not_built",
    `${what} is not built yet (stream ${stream}, docs/plan.md §1.125)`,
  );
}
