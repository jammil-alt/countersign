// The records behind a step, an inbox item or a message (`sources`, invariant 10) as Receipts that
// open their record page. Ids that aren't record ids (a sample's "r1") show without a link.
import { isUuid } from "@countersign/core";
import { Link } from "react-router-dom";
import { Icon } from "../ui/icons";

/** "Record ·3f9a1c": the id's random tail, enough to tell two apart in a list. */
export function sourceLabel(id: string): string {
  return isUuid(id) ? `Record ·${id.slice(-6)}` : id;
}

export function SourceLinks({
  ids,
  href,
  testId,
}: {
  ids: readonly string[];
  /** The record page for an id, in this surface. */
  href: (id: string) => string;
  testId?: string;
}) {
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
            {sourceLabel(id)}
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
