// A client's channels as resolved (R8, docs/plan.md §1.86; ARCHITECTURE §10.14 "Communications"):
// one row a channel, what it is and the number or address it sends from. The portal's Channels page
// and the back office's client settings both list them; an agent's own may be told apart from the
// account's by a word the caller chooses (the portal's in the reader's language, ours in English).
import type { ChannelLine, ReachChannel } from "@countersign/core";
import type { PlainKey } from "../i18n/catalog";
import { useI18n } from "../i18n/i18n";
import { Tag } from "../ui/primitives";

export const CHANNEL_KIND_KEY: Record<ReachChannel, PlainKey> = {
  email: "reach.channel.email",
  sms: "reach.channel.sms",
  whatsapp: "reach.channel.whatsapp",
  voice: "reach.channel.voice",
};

export function ChannelLines({
  lines,
  sourceText,
  testId,
}: {
  lines: ChannelLine[];
  /** A word for where each line comes from ("Its own"); absent: not shown. */
  sourceText?: (line: ChannelLine) => string;
  testId: string;
}) {
  const { t } = useI18n();
  return (
    <ul data-testid={testId}>
      {lines.map((line) => (
        <li
          key={`${line.kind}:${line.connectionId}`}
          data-testid={`${testId}-${line.kind}`}
          className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-6 py-3 last:border-b-0 max-sm:px-4"
        >
          <span className="w-28 shrink-0 text-sm text-ink-muted">
            {t(CHANNEL_KIND_KEY[line.kind])}
          </span>
          <span className="min-w-0 flex-1 break-words text-ink">
            {line.address ?? (
              <span className="text-sm text-ink-muted">{t("channels.notSetUp")}</span>
            )}
          </span>
          {sourceText ? <Tag>{sourceText(line)}</Tag> : null}
        </li>
      ))}
    </ul>
  );
}
