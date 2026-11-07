// The records behind a step, an inbox item or a message (`sources`, invariant 10) as Receipts that
// open their record page. Ids that aren't record ids (a sample's "r1") show without a link.
import { isUuid } from "@countersign/core";
import { Link } from "react-router-dom";
import { EN, type I18n, useI18n } from "../i18n/i18n";
import { Icon } from "../ui/icons";

/** "Record ·3f9a1c": the id's random tail, enough to tell two apart in a list. */
export function sourceLabel(id: string, { t }: Pick<I18n, "t"> = EN): string {
  return isUuid(id) ? t("record.source", { tail: id.slice(-6) }) : id;
}

export function SourceLinks({
  ids,
  href,
  testId,
  names,
}: {
  ids: readonly string[];
  /** The record page for an id, in this surface. */
  href: (id: string) => string;
  testId?: string;
  /** The records' names by id, where the API served them ("Northline Panel Supply · 20418"). */
  names?: Readonly<Record<string, string>> | undefined;
}) {
  const i18n = useI18n();
  if (ids.length === 0) return null;
  return (
    <span data-testid={testId} className="mt-1 flex flex-wrap gap-1.5">
      {ids.map((id) =>
        isUuid(id) ? (
          <Link
            key={id}
            to={href(id)}
            title={id}
            className="mz-receipt"
            data-testid={`source-${id}`}
          >
            <Icon name="receipt" size={14} className="ds-icon" />
            {names?.[id] ?? sourceLabel(id, i18n)}
          </Link>
        ) : (
          <span key={id} className="mz-receipt cursor-default">
            <Icon name="receipt" size={14} className="ds-icon" />
            {id}
          </span>
        ),
      )}
    </span>
  );
}

/** The string ids in an output's `sources` (the same reading as the API's timeline). */
export function sourcesOf(output: unknown): string[] {
  if (output === null || typeof output !== "object" || Array.isArray(output)) return [];
  const s = (output as { sources?: unknown }).sources;
  return Array.isArray(s) ? s.filter((x): x is string => typeof x === "string") : [];
}
