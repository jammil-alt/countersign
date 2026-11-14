// A run's title from what it is about (the API's `subject`, core RunSubject), in the reader's
// language: "Northline Panel Supply · Invoice 20418", "QuickBooks bill 20418 · Northline Panel
// Supply". Shared by the run lists, search and the run pages of both surfaces.
import { pickLocalized, type RunSubject } from "@countersign/core";
import { EN, type I18n } from "../i18n/i18n";
import { eventLabel } from "./labels";

/**
 * The run's title from its document or its first change, or null when only its trigger is known
 * (each surface then titles it its own way).
 */
export function subjectTitle(
  subject: RunSubject | null | undefined,
  { t, locale }: Pick<I18n, "t" | "locale"> = EN,
): string | null {
  if (!subject) return null;
  switch (subject.kind) {
    case "document": {
      const invoice = subject.number ? t("run.subject.invoice", { number: subject.number }) : null;
      const parts = [subject.vendor, invoice].filter((p): p is string => !!p);
      return parts.length > 0 ? parts.join(" · ") : subject.filename;
    }
    case "change": {
      const name = pickLocalized(subject.name, locale);
      const head = subject.number ? `${name} ${subject.number}` : name;
      return subject.with ? `${head} · ${subject.with}` : head;
    }
    case "trigger":
      return null;
  }
}

const STARTED_BY_TITLE: Record<string, string> = {
  schedule: "Scheduled run",
  event: "Started by an event",
  webhook: "Started by a webhook",
  manual: "Started by hand",
  message: "Started by a message",
  handoff: "Started by another agent",
  person: "Started by a person at the client",
};

/**
 * The back office's title for a run: its subject, else the trigger in plain words ("When an
 * invoice has been read"), else the workflow's name.
 */
export function opsRunTitle(
  subject: RunSubject | null | undefined,
  fallback: string | null = null,
): string {
  const title = subjectTitle(subject);
  if (title) return title;
  if (subject?.kind === "trigger") {
    if (subject.event) return `When ${eventLabel(subject.event)}`;
    if (subject.startedBy) return STARTED_BY_TITLE[subject.startedBy] ?? "Run";
  }
  return fallback ?? "Run";
}

/**
 * The run's title without its counterparty, for a table that has little room: "Invoice 20418",
 * "QuickBooks bill 20418". The full title (opsRunTitle) goes in the cell's tooltip.
 */
export function opsRunShortTitle(
  subject: RunSubject | null | undefined,
  fallback: string | null = null,
  { t, locale }: Pick<I18n, "t" | "locale"> = EN,
): string {
  if (subject?.kind === "document" && subject.number)
    return t("run.subject.invoice", { number: subject.number });
  if (subject?.kind === "change") {
    const name = pickLocalized(subject.name, locale);
    return subject.number ? `${name} ${subject.number}` : name;
  }
  return opsRunTitle(subject, fallback);
}
