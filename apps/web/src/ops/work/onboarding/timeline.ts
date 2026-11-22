// A deal's timeline with onboarding in it (docs/cases-plan.md §3.1 "stages are a record, not a
// gate"; §4.4; docs/plan.md §1.149): the stages a deal passed over show as skipped, with who and
// why, and its intakes' log (sent, delivered, opened, signed in, answered…) goes in among the
// deal's own lines, by time.

import type { DealDetail, IntakeEventKind, OpsIntakeView } from "@countersign/core";
import { opsIntakeRoutes } from "@countersign/core";
import { useEffect, useState } from "react";
import { useApi, useApiClient } from "../../../api/useApi";
import { intakeEventWords } from "./words";

/**
 * The stages a deal skipped: its `stage` lines that read "Skipped <stage>…".
 */
// DECISION (§1.149, stream screens): the API writes a skipped stage as a `stage` line whose body is
// "Skipped Diagnostic: signed up directly." (meta.skipped is not in DealActivityView), so the
// stepper reads the stage's name off the line. If a skipped stage is later reached, it is no longer
// shown as skipped.
export function skippedStages(detail: Pick<DealDetail, "activity" | "stages">): Set<string> {
  const out = new Set<string>();
  for (const a of detail.activity) {
    if (a.kind !== "stage" || !a.body.startsWith("Skipped ")) continue;
    const rest = a.body.slice("Skipped ".length);
    const stage = detail.stages
      .filter((s) => rest.startsWith(s.name))
      .sort((x, y) => y.name.length - x.name.length)[0];
    if (stage) out.add(stage.id);
  }
  return out;
}

/** Whether a deal's line is a skipped stage. */
export const isSkippedLine = (a: { kind: string; body: string }) =>
  a.kind === "stage" && a.body.startsWith("Skipped ");

export interface OnboardingLine {
  id: string;
  kind: IntakeEventKind;
  body: string;
  /** The person it's about, by name. */
  who: string | null;
  createdAt: string;
  /** A delivery that failed: shown in risk. */
  failed: boolean;
  /**
   * §1.220: the newest line of an invite that didn't go out, while it still hasn't: Send it again
   * is offered on it.
   */
  sendAgain?: { intakeId: string; personId: string };
}

/** An email the pass skipped or gave up on (not one held back because the intake closed). */
const notSent = (meta: Record<string, unknown>) =>
  meta.status === "failed" || (meta.status === "skipped" && meta.reason !== "closed");

/** An intake's log as timeline lines. */
export function onboardingLines(view: OpsIntakeView): OnboardingLine[] {
  const people = new Map(view.people.map((p) => [p.id, p.name]));
  const sections = new Map(view.guide.sections.map((s) => [s.key, s.title]));
  const unsent = new Set(view.unsentInvites ?? []);
  const offered = new Set<string>();
  // Newest first, so the first failure of each person's invite is where Send it again goes.
  return view.events.map((e) => {
    const who = e.personId ? (people.get(e.personId) ?? null) : null;
    const key = typeof e.meta.sectionKey === "string" ? e.meta.sectionKey : null;
    const didntGo = e.kind === "sent" && notSent(e.meta);
    const line: OnboardingLine = {
      id: `intake:${e.id}`,
      kind: e.kind,
      body: didntGo
        ? `The invite${who ? ` to ${who}` : ""} didn't go out.`
        : intakeEventWords(e.kind, who, key ? (sections.get(key) ?? null) : null),
      who,
      createdAt: e.at,
      failed: e.kind === "bounced" || e.kind === "wrong_account" || didntGo,
    };
    const invite = e.meta.email === "invite";
    if (
      invite &&
      (didntGo || e.kind === "bounced") &&
      e.personId &&
      unsent.has(e.personId) &&
      !offered.has(e.personId)
    ) {
      offered.add(e.personId);
      line.sendAgain = { intakeId: view.intake.id, personId: e.personId };
    }
    return line;
  });
}

/** At most this many of a deal's intakes are read for its timeline (newest first). */
const INTAKES_READ = 3;

/**
 * The onboarding lines for a deal: its company's intakes that name this deal (or name none, for a
 * file's), each one's log. Quiet when the intake routes aren't there: the deal's own lines still show.
 */
export function useOnboardingLines(detail: DealDetail): OnboardingLine[] {
  const d = detail.deal;
  const query = d.client ? { client: d.client.id } : d.fileId ? { file: d.fileId } : null;
  const list = useApi(opsIntakeRoutes.opsIntakes, query ? { query } : null);
  const api = useApiClient();
  const ids = (list.data?.intakes ?? [])
    .filter(
      (i) => i.dealId === d.id || (i.dealId === null && d.fileId !== null && i.fileId === d.fileId),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, INTAKES_READ)
    .map((i) => `${i.id}@${i.updatedAt}`);
  const key = ids.join(",");
  const [lines, setLines] = useState<OnboardingLine[]>([]);
  useEffect(() => {
    if (!key) {
      setLines([]);
      return;
    }
    let live = true;
    const wanted = key.split(",").map((k) => k.split("@")[0] ?? "");
    Promise.allSettled(
      wanted.map((id) => api.call(opsIntakeRoutes.opsIntake, { params: { id } })),
    ).then((out) => {
      if (!live) return;
      setLines(out.flatMap((r) => (r.status === "fulfilled" ? onboardingLines(r.value) : [])));
    });
    return () => {
      live = false;
    };
  }, [api, key]);
  return lines;
}
