// R8 (docs/plan.md §1.86; ARCHITECTURE §10.14 "Checks", "Deadlines"): what a step's checks did,
// on a run's timeline, shared by the client's run page and the back office's run view (one
// component, words through t(): the back office reads them in English). A confer is a step of its
// own ("Checked with Dana: agrees", "A second check: agrees"), never its model, prompt or cost; an
// approval lists each approver and what came of it, under the mode it asked in; a step that went
// on, or stopped, because nobody answered says so; an urgent notice says whether it was seen.
// Colours by meaning: people copper, waiting on someone signal with a word, errors risk, done
// positive.
import type { ConferView, TimelineChecks } from "@countersign/core";
import type { PlainKey } from "../i18n/catalog";
import { type I18n, useI18n } from "../i18n/i18n";
import { shortTime } from "./format";

const VERDICT: Record<ConferView["verdict"], PlainKey> = {
  agree: "run.confer.verdict.agree",
  disagree: "run.confer.verdict.disagree",
  unsure: "run.confer.verdict.unsure",
  no_answer: "run.confer.verdict.no_answer",
};

const MODE: Record<NonNullable<TimelineChecks["approval"]>["mode"], PlainKey> = {
  in_turn: "run.approval.mode.in_turn",
  any: "run.approval.mode.any",
  all: "run.approval.mode.all",
};

const ROLE: Record<string, PlainKey> = {
  client_admin: "run.who.client_admin",
  client_user: "run.who.client_user",
  lead: "run.who.lead",
  operator: "run.who.operator",
};

/** Who, in the reader's words: their name, else their role, else "someone on your team". */
export function whoWords(
  { t }: Pick<I18n, "t">,
  who: { name?: string | null | undefined; role?: string | null | undefined },
): string {
  if (who.name) return who.name;
  const key = who.role ? ROLE[who.role] : undefined;
  return t(key ?? "run.who.someone");
}

/** A confer's line, its title on the timeline: "Checked with Dana: agrees". */
export function conferTitle(
  i18n: Pick<I18n, "t">,
  c: NonNullable<TimelineChecks["confer"]>,
): string {
  const { t } = i18n;
  if (c.reviewer === "ai") return t("run.confer.second", { verdict: t(VERDICT[c.verdict]) });
  const who = whoWords(i18n, { name: c.name, role: c.who });
  if (c.away) return t("run.confer.away", { who });
  return t("run.confer.person", { who, verdict: t(VERDICT[c.verdict]) });
}

/** A confer's tone: a person's answer is copper; a disagreement a person must look at is signal. */
export function conferTone(c: NonNullable<TimelineChecks["confer"]>): "person" | "ink" {
  return c.reviewer === "person" ? "person" : "ink";
}

export function StepChecks({
  checks,
  testId = "run-step-checks",
}: {
  checks: TimelineChecks;
  testId?: string;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const time = (iso: string | null) => shortTime(iso, undefined, i18n);
  const { confer, approval, noAnswer, urgent } = checks;
  if (!confer && !approval && !noAnswer && !urgent) return null;
  return (
    <div className="flex flex-col gap-1 text-sm" data-testid={testId}>
      {confer?.note ? (
        <p className="text-ink" data-testid={`${testId}-note`}>
          “{confer.note}”
        </p>
      ) : null}
      {approval ? (
        <div data-testid={`${testId}-approval`}>
          <p className="text-ink-muted">{t(MODE[approval.mode])}</p>
          <ul className="flex flex-col gap-0.5">
            {approval.approvers.map((a) => {
              const who = whoWords(i18n, a);
              return (
                <li
                  key={a.itemId}
                  data-testid={`${testId}-approver`}
                  data-state={a.state}
                  className={
                    a.state === "approved"
                      ? "text-copper-ink"
                      : a.state === "waiting"
                        ? "ui-tone-signal"
                        : a.state === "rejected"
                          ? "text-ink"
                          : "text-ink-muted"
                  }
                >
                  {t(`run.approval.approver.${a.state}`, { who })}
                  {a.at ? (
                    <span className="text-ink-muted figures">{` · ${time(a.at)}`}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {noAnswer ? (
        <p
          data-testid={`${testId}-no-answer`}
          className={noAnswer === "stopped" ? "ui-tone-risk" : "text-ink-muted"}
        >
          {t(noAnswer === "stopped" ? "run.noAnswer.stopped" : "run.noAnswer.proceeded")}
        </p>
      ) : null}
      {urgent ? (
        <p
          data-testid={`${testId}-urgent`}
          data-state={urgent.state}
          className={
            urgent.state === "seen"
              ? "ui-tone-positive"
              : urgent.state === "not_seen"
                ? "ui-tone-risk"
                : "ui-tone-signal"
          }
        >
          {urgent.state === "seen"
            ? t("run.urgent.seen", { time: time(urgent.seenAt) })
            : urgent.state === "not_seen"
              ? t("run.urgent.notSeen")
              : urgent.dueAt
                ? t("run.urgent.waiting", { time: time(urgent.dueAt) })
                : t("run.urgent.waitingNoTime")}
        </p>
      ) : null}
    </div>
  );
}
