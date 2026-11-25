// The words of a sandbox run's view (docs/plan.md §1.243), passed in by each side: the portal
// builds them from the reader's language, the back office from English (`EN`) with its own lines
// where it speaks of the client rather than to them. The shared parts never hold a string.
import type { SandboxChange, SandboxRun, SandboxSent, SandboxStep } from "@countersign/core";
import type { I18n } from "../i18n/i18n";
import type { ChipState } from "../ui/status";

/** A sandbox run's status as a chip: running in slate, done positive, failed risk. */
export const SANDBOX_CHIP: Record<SandboxRun["status"], ChipState> = {
  running: "running",
  done: "done",
  failed: "failed",
};

export interface SandboxWords {
  runStatus: Record<SandboxRun["status"], string>;
  /** "A test run. Nothing was written to your tools and nothing was sent." */
  notWritten: string;
  stepsTitle: string;
  /** No step has started yet. */
  starting: string;
  stepState: Record<SandboxStep["state"], string>;
  wouldTitle: string;
  wouldHint: string;
  noChanges: string;
  noticesTitle: string;
  noticeTo: (to: string) => string;
  /** "Email", "Text", "Call"… for a channel; the channel as written when we have no word. */
  channel: (channel: string) => string;
  /** A message's title in words ("Email to Northside Lumber"); a record keeps its step's name. */
  changeTitle: (change: SandboxChange) => string;
  /** The badge on every change: it was not written. */
  notWrittenBadge: string;
  stepName: (name: string) => string;
  from: string;
  to: string;
  subject: string;
  noSubject: string;
  noText: string;
  attachments: (count: number) => string;
  field: string;
  before: string;
  after: string;
  empty: string;
  sendButton: string;
  sending: string;
  /** Where "Send to me" sends it: from the client's own mailbox or number, to this person. */
  sendTo: (channel: "email" | "sms", to: string) => string;
  /** A send already made: who, when and where. */
  sentLine: (sent: SandboxSent) => string;
}

/** The view's words in the reader's language: the client speaking to their own tools. */
export function sandboxWords({ t, fmt }: Pick<I18n, "t" | "fmt">): SandboxWords {
  const channelWord = (channel: string): string => {
    switch (channel) {
      case "email":
        return t("sandbox.channel.email");
      case "sms":
        return t("sandbox.channel.sms");
      case "whatsapp":
        return t("sandbox.channel.whatsapp");
      case "voice":
        return t("sandbox.channel.voice");
      default:
        return t("sandbox.channel.other");
    }
  };
  return {
    runStatus: {
      running: t("sandbox.status.running"),
      done: t("sandbox.status.done"),
      failed: t("sandbox.status.failed"),
    },
    notWritten: t("sandbox.run.notWritten"),
    stepsTitle: t("sandbox.run.steps"),
    starting: t("sandbox.run.starting"),
    stepState: {
      done: t("sandbox.step.done"),
      running: t("sandbox.step.running"),
      waiting: t("sandbox.step.waiting"),
      skipped: t("sandbox.step.skipped"),
      failed: t("sandbox.step.failed"),
    },
    wouldTitle: t("sandbox.run.would"),
    wouldHint: t("sandbox.run.wouldHint"),
    noChanges: t("sandbox.run.noChanges"),
    noticesTitle: t("sandbox.run.notices"),
    noticeTo: (to) => t("sandbox.notice.to", { to }),
    channel: channelWord,
    changeTitle: (change) => {
      const m = change.message;
      if (!m) return change.title;
      const to = m.toName || m.to || t("sandbox.change.aContact");
      switch (m.channel) {
        case "email":
          return t("sandbox.change.email", { to });
        case "sms":
          return t("sandbox.change.sms", { to });
        case "whatsapp":
          return t("sandbox.change.whatsapp", { to });
        case "voice":
          return t("sandbox.change.voice", { to });
        default:
          return t("sandbox.change.other", { to });
      }
    },
    notWrittenBadge: t("sandbox.change.notWritten"),
    stepName: (name) => t("sandbox.change.step", { name }),
    from: t("sandbox.message.from"),
    to: t("sandbox.message.to"),
    subject: t("sandbox.message.subject"),
    noSubject: t("sandbox.message.noSubject"),
    noText: t("sandbox.message.noText"),
    attachments: (count) => t("sandbox.message.attachments", { count }),
    field: t("sandbox.record.field"),
    before: t("sandbox.record.before"),
    after: t("sandbox.record.after"),
    empty: t("sandbox.record.empty"),
    sendButton: t("sandbox.send.button"),
    sending: t("common.sending"),
    sendTo: (channel, to) =>
      channel === "email" ? t("sandbox.send.toEmail", { to }) : t("sandbox.send.toSms", { to }),
    sentLine: (s) =>
      s.byName
        ? t("sandbox.sent.by", { name: s.byName, when: fmt.time(s.at), to: s.to })
        : t("sandbox.sent.at", { when: fmt.time(s.at), to: s.to }),
  };
}
