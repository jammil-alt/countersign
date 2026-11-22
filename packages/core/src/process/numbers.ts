// One number per step, wherever it is shown (docs/sop-plan.md §6a, owner 2026-11-22): the
// builder's chart, the SOP and the client's view-only workflow say "5 A1" for the first step of
// path A of decision 5, and "6.2" for the second step inside loop 6. A decision's paths are
// lettered in order, then Otherwise.
//
// DECISION (§6a): the chart's numbering, which the owner sees every day, is the one; the SOP
// followed it rather than keep its own ("5.1").

/** A path's letter: A, B, … Z, then AA, AB. */
export function pathLetter(index: number): string {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  return index < letters.length
    ? (letters[index] as string)
    : `${pathLetter(Math.floor(index / letters.length) - 1)}${letters[index % letters.length]}`;
}

/** The number of the `index`th step (from 0) of a decision's path: "5 A1". */
export function pathStepNumber(decision: string, letter: string, index: number): string {
  return `${decision} ${letter}${index + 1}`;
}

/** The number of the `index`th step (from 0) inside a loop: "6.2". */
export function loopStepNumber(loop: string, index: number): string {
  return `${loop}.${index + 1}`;
}
