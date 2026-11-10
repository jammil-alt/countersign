// The API's own script problems (docs/plan.md §1.86 "Scripts (wave 4)"): those that need the
// recording or the site, beside core's `scriptProblemList` (a definition's own). Each is made with
// its code and values for the portal to word in the client's language, and our words for the back
// office.

import type { ScriptProblemView } from "@countersign/core";

/** Nothing is recorded yet. */
export function emptyProblem(): ScriptProblemView {
  return { code: "empty", params: {}, text: "nothing is recorded yet" };
}

/** A definition that didn't parse: where, and what was wrong there. */
export function invalidProblem(path: string, message: string): ScriptProblemView {
  return { code: "invalid", params: { path, message }, text: `${path}: ${message}` };
}

/** The login's site is no longer in our catalogue. */
export function siteGoneProblem(): ScriptProblemView {
  return { code: "site_gone", params: {}, text: "this site is no longer in our catalogue" };
}

/** A step opens an address agents may not open on this site. */
export function offSiteProblem(step: string, url: string, reason: string): ScriptProblemView {
  return {
    code: "off_site",
    params: { step, url, reason },
    text: `step ${step} opens ${url}: ${reason}`,
  };
}
