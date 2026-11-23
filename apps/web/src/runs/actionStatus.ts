// A change to a client's tool, by its state, as the portal words it (the run's Changes card and a
// step's Data tab). One place, so both say the same thing.

import type { PlainKey } from "../i18n/catalog";
import type { Tone } from "../ui/primitives";

const ACTION_WORDS: Record<string, PlainKey> = {
  proposed: "action.status.proposed",
  approved: "action.status.approved",
  executing: "action.status.executing",
  done: "action.status.done",
  rejected: "action.status.rejected",
  failed: "action.status.failed",
};

/** Made = done; waiting = on a person (signal); approved = a person signed (copper); failed = risk. */
const ACTION_TONE: Record<string, Tone> = {
  proposed: "warning",
  approved: "person",
  done: "positive",
  failed: "risk",
};

/**
 * A change's words and tone. S4.5: one nobody answered in time reads "Not made: no answer in
 * time", never "Waiting for approval" or a person's "Rejected".
 */
export function actionStatus(a: { status: string; expired?: boolean | undefined }): {
  key: PlainKey | null;
  tone: Tone;
} {
  if (a.expired === true) return { key: "action.status.expired", tone: "neutral" };
  return { key: ACTION_WORDS[a.status] ?? null, tone: ACTION_TONE[a.status] ?? "neutral" };
}
