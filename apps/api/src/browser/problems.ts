// A script's problems as codes with their values (docs/plan.md §1.86 "Scripts (wave 4)"): the
// portal words them in the client's language from `code` and `params`; the back office reads
// `text`, our own words. Core's `scriptProblems` answers in words only, so each of its sentences is
// matched here; ./problems.test.ts holds every one of them to a code, so a reworded sentence is
// caught rather than falling to "other".

import type { ScriptProblem } from "@countersign/core";

type Code = ScriptProblem["code"];

// DECISION: the codes are read from core's sentences here (packages/core/src/browser is not this
// change's to edit); a sentence no pattern knows is `other`, its text still shown. Moving the codes
// into core's `scriptProblems` itself is the cleaner home, left for when core changes next.
const PATTERNS: readonly (readonly [Code, RegExp, readonly string[]])[] = [
  ["empty", /^nothing is recorded yet$/, []],
  ["duplicate_name", /^two (inputs|outputs|steps) are called (.+)$/, ["what", "name"]],
  ["reserved_output", /^"(.+)" can't be an output's name$/, ["name"]],
  ["unknown_input", /^step (\S+) uses (.+), which isn't an input$/, ["step", "name"]],
  ["unknown_output", /^step (\S+) reads (.+), which isn't an output$/, ["step", "name"]],
  ["output_type", /^step (\S+) can't read (.+) as (\w+)$/, ["step", "name", "type"]],
  ["unused_input", /^no step uses the input (.+)$/, ["name"]],
  ["unread_output", /^no step reads the output (.+)$/, ["name"]],
  ["output_read_twice", /^more than one step reads (.+)$/, ["name"]],
  ["submit_not_write", /^a script that submits a form is a write/, []],
  ["write_without_submit", /^a write script submits:/, []],
  ["submits_twice", /^a script submits once$/, []],
  ["submit_not_last", /^the submit is the script's last step$/, []],
  ["reverse_not_write", /^only a write names a reverse script$/, []],
  [
    "reverse_unknown_input",
    /^the reverse script's (.+) comes from (.+), which isn't an input$/,
    ["name", "from"],
  ],
  [
    "reverse_unknown_output",
    /^the reverse script's (.+) comes from (.+), which isn't an output$/,
    ["name", "from"],
  ],
  ["site_gone", /^this site is no longer in our catalogue$/, []],
  ["off_site", /^step (\S+) opens (\S+): (.+)$/, ["step", "url", "reason"]],
];

/** One problem sentence as a code, its values and the sentence itself. */
export function problemOf(text: string): ScriptProblem {
  for (const [code, pattern, names] of PATTERNS) {
    const m = pattern.exec(text);
    if (!m) continue;
    const params = Object.fromEntries(names.map((n, i) => [n, m[i + 1] ?? ""]));
    return { code, params, text };
  }
  return { code: "other", params: {}, text };
}

/** A definition that didn't parse: where, and what was wrong there. */
export function invalidProblem(path: string, message: string): ScriptProblem {
  return { code: "invalid", params: { path, message }, text: `${path}: ${message}` };
}
