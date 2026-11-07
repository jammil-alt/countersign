// Small helpers for the Table and an agent's page (C1, C2): the go-live stage's word, the part of
// the day and the client's day. An agent's and a run's state live in ./status.ts.
import type { Translate } from "../i18n/catalog";

/** Before go-live (trial, the client's sign-off): a word beside the chip. Null when live. */
export function stageWord(stage: string | null, t: Translate): string | null {
  if (stage === "trial") return t("agent.stage.trial");
  if (stage === "signoff") return t("agent.stage.signoff");
  return null;
}

/** "Good morning": by the hour where the client is (their time zone), else the reader's. */
export function partOfDay(
  now: Date,
  timeZone: string | undefined,
): "morning" | "afternoon" | "evening" {
  let hour = now.getHours();
  try {
    hour = Number(
      new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone }).format(now),
    );
  } catch {
    // An unknown time zone: the reader's clock.
  }
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

/** "Thursday, November 5" in the reader's language, on the client's day. */
export function longDay(now: Date, intl: string, timeZone: string | undefined): string {
  const options: Intl.DateTimeFormatOptions = { weekday: "long", month: "long", day: "numeric" };
  try {
    return new Intl.DateTimeFormat(intl, { ...options, timeZone }).format(now);
  } catch {
    return new Intl.DateTimeFormat(intl, options).format(now);
  }
}

/** The same calendar day where the client is. */
export function sameDay(a: Date, b: Date, timeZone: string | undefined): boolean {
  const day = (d: Date) => {
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone }).format(d);
    } catch {
      return d.toDateString();
    }
  };
  return day(a) === day(b);
}
