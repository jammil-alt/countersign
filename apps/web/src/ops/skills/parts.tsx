// Pieces the skills screens share (O4 Skills and automations, O8 New skill, the skill and
// automation pages): a schema's fields as "Takes in" / "Gives back", a chain of steps or
// in → out tags with arrows, and the version chip.
import type { Step } from "@countersign/core";
import { Fragment, type ReactNode } from "react";
import { Card, Tag } from "../../ui/primitives";

/** A JSON Schema property's type in plain words: `match | none | ask`, `text`, `date`, `list`. */
function typeText(schema: unknown): string {
  if (!schema || typeof schema !== "object") return "any";
  const s = schema as {
    type?: unknown;
    enum?: unknown;
    format?: unknown;
    items?: unknown;
    description?: unknown;
  };
  if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum.map(String).join(" | ");
  if (s.format === "date" || s.format === "date-time") return "date";
  switch (s.type) {
    case "string":
      return "text";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "yes or no";
    case "array":
      return `list of ${typeText(s.items)}`;
    case "object":
      return "record";
    default:
      return "any";
  }
}

/** The top-level fields of a JSON Schema object, each with its type in words. */
export function schemaFields(schema: unknown): { key: string; type: string; list: boolean }[] {
  if (!schema || typeof schema !== "object") return [];
  const props = (schema as { properties?: unknown }).properties;
  if (!props || typeof props !== "object") return [];
  return Object.entries(props as Record<string, unknown>).map(([key, value]) => {
    const list = (value as { type?: unknown } | null)?.type === "array";
    return {
      key,
      type: list ? typeText((value as { items?: unknown }).items) : typeText(value),
      list,
    };
  });
}

/** "Takes in" / "Gives back": a schema's fields in mono with their types on the right. */
export function SchemaCard({
  title,
  schema,
  badge,
  testId,
}: {
  title: string;
  schema: unknown;
  badge?: ReactNode;
  testId?: string | undefined;
}) {
  const fields = schemaFields(schema);
  return (
    <Card pad {...(testId ? { testId } : {})}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="type-subheading text-ink">{title}</h3>
        {badge}
      </div>
      {fields.length === 0 ? (
        <p className="text-sm text-ink-muted">Nothing.</p>
      ) : (
        <ul className="flex flex-col gap-2 text-sm">
          {fields.map((f) => (
            <li key={f.key} className="flex items-baseline justify-between gap-4">
              <span className="reference text-ink">
                {f.key}
                {f.list ? "[]" : ""}
              </span>
              <span className="reference text-right text-ink-muted">{f.type}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Tags joined by arrows: a step chain, or a skill's in → out. Person items in copper. */
export function Chain({
  items,
  testId,
}: {
  items: readonly { key: string; label: string; person?: boolean }[];
  testId?: string;
}) {
  return (
    <div data-testid={testId} className="flex flex-wrap items-center gap-1.5 text-sm">
      {items.map((item, i) => (
        <Fragment key={item.key}>
          {i > 0 ? (
            <span aria-hidden className="text-ink-muted">
              →
            </span>
          ) : null}
          <Tag tone={item.person ? "person" : "neutral"}>{item.label}</Tag>
        </Fragment>
      ))}
    </div>
  );
}

/** An automation's top-level steps as a chain: each step's name, person steps in copper. */
export function stepChain(
  steps: readonly Step[],
): { key: string; label: string; person?: boolean }[] {
  return steps.map((s) => ({
    key: s.id,
    label: s.kind === "person" ? `Person: ${s.name}` : s.name,
    person: s.kind === "person",
  }));
}

/** A skill's "in → out" as two tags. */
export function inOut(inputs: readonly string[], outputs: readonly string[]) {
  return [
    { key: "in", label: inputs.join(", ") || "nothing" },
    { key: "out", label: outputs.join(", ") || "nothing" },
  ];
}

/** "v3", the live version, else "Draft v1"; nothing for a built-in without versions. */
export function versionText(live: number | null, latest: number | null): string {
  if (live !== null) return `v${live}`;
  if (latest !== null) return `Draft v${latest}`;
  return "";
}

/** "40%" from a 0–1 rate. */
export function percent(rate: number): string {
  return `${Math.round(rate * 1000) / 10}%`;
}
