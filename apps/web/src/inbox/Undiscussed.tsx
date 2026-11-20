// B3 (docs/builder-plan.md §5): a change whose step rests on a decision in the agent's manual that
// nobody has discussed yet says so on its card, one line each: "Based on a decision nobody has
// discussed yet: freight stays out of the catalog." The runtime puts them in the item's payload
// (`undiscussed`) by code; shared by the portal's Inbox and the back office's.

import { inSentence, readUndiscussed } from "@countersign/core";
import { useI18n } from "../i18n/i18n";

export function UndiscussedLines({
  payload,
  testId = "inbox-undiscussed",
}: {
  payload: Record<string, unknown>;
  testId?: string;
}) {
  const { t } = useI18n();
  const list = readUndiscussed(payload.undiscussed);
  if (list.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 border-l-2 border-line pl-3" data-testid={testId}>
      {list.map((d) => (
        <li key={`${d.id}:${d.what}`} className="text-sm text-ink">
          {t("inbox.undiscussed", { what: inSentence(d.what) })}
        </li>
      ))}
    </ul>
  );
}
