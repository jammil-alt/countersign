// What an agent is doing, in one chip, for the Table's cards and the agent page's header (C1, C2):
// paused first, then waiting on you, then running, then setting up (bench), else ready. The words
// are the reader's; the colour comes from the shared StatusChip mapping.
import type { TableView } from "@countersign/core";
import type { Translate } from "../i18n/catalog";
import type { ChipState } from "../ui/status";

type Service = Pick<TableView["services"][number], "status" | "stage" | "now">;

const GOING = new Set(["queued", "running", "waiting"]);

export function agentChip(s: Service, t: Translate): { state: ChipState; label: string } {
  if (s.status === "paused") return { state: "paused", label: t("service.status.paused") };
  if (s.now?.waitingOnYou) return { state: "waiting", label: t("common.waitingOnYou") };
  if (s.now && GOING.has(s.now.status)) return { state: "running", label: t("agent.running") };
  if (s.stage === "bench" || s.status === "draft" || s.status === "testing") {
    return { state: "setup", label: t("agent.settingUp") };
  }
  return { state: "idle", label: t("agent.ready") };
}

/** Whether the latest run is still going (it has a current step to show). */
export function isGoing(now: Service["now"]): boolean {
  return now !== null && GOING.has(now.status);
}

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
