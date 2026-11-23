// The records behind a step, an inbox item or a message (`sources`, invariant 10) as Receipts that
// open their record page. Ids that aren't record ids (a sample's "r1") show without a link.
import { isUuid } from "@countersign/core";
import { Link } from "react-router-dom";
import { EN, type I18n, useI18n } from "../i18n/i18n";
import { Icon } from "../ui/icons";

/** "Record ·3f9a1c": the id's random tail, enough to tell two apart in a list. */
export function sourceLabel(id: string, { t }: Pick<I18n, "t"> = EN): string {
  return isUuid(id) ? t("record.source", { tail: id.slice(-6) }) : refLabel(id);
}

/** A connector's prefix on a record kind an agent wrote ("QboBill"), and its name. */
const KIND_PREFIXES: [RegExp, string][] = [[/^qbo(?=[A-Z_])/i, "QuickBooks"]];

/**
 * A record an agent named by its kind and the tool's id, in words (S5.6): "vendor:59" →
 * "Vendor 59", "QboBill:146" → "QuickBooks bill 146". Anything else as written.
 */
export function refLabel(ref: string): string {
  const m = /^([A-Za-z][A-Za-z_]*)[:#](\S+)$/.exec(ref);
  if (!m?.[1] || !m[2]) return ref;
  let kind = m[1];
  let tool: string | null = null;
  for (const [re, name] of KIND_PREFIXES) {
    if (re.test(kind)) {
      kind = kind.replace(re, "").replace(/^_/, "");
      tool = name;
    }
  }
  const words = kind
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_+/g, " ")
    .toLowerCase()
    .trim();
  if (!words) return ref;
  const said = tool ? `${tool} ${words}` : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
  return `${said} ${m[2]}`;
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
      {/* A record named twice (a finding counting one run twice) shows once. */}
      {[...new Set(ids)].map((id) =>
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
          <span key={id} className="mz-receipt cursor-default" title={id}>
            <Icon name="receipt" size={14} className="ds-icon" />
            {names?.[id] ?? refLabel(id)}
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
