// The actions a Loop may read with, picked from the action catalog's Gets (`readGroups`): grouped
// under the connector or area they belong to. Nothing that changes, saves or sends is offered; a
// Loop reads only, and what it decides is saved by a step after it (docs/step-model-plan.md §8).
import type { ToolSpec } from "@countersign/core";
import { useMemo } from "react";
import { type ReadGroup, readGroups } from "./loop-form";

export function ReadsPicker({
  tools,
  connectors,
  value,
  onChange,
  error,
}: {
  tools: readonly ToolSpec[];
  connectors: readonly { id: string; name: string }[];
  value: readonly string[];
  onChange(next: string[]): void;
  error?: string | undefined;
}) {
  const groups: ReadGroup[] = useMemo(() => readGroups(tools, connectors), [tools, connectors]);
  const picked = new Set(value);
  const known = new Set(groups.flatMap((g) => g.actions.map((a) => a.id)));
  // A read the skill names that is no longer a Get (or gone): shown, so it can be taken off.
  const stray = value.filter((id) => !known.has(id));
  const toggle = (id: string) =>
    onChange(picked.has(id) ? value.filter((v) => v !== id) : [...value, id]);
  return (
    <div className="flex flex-col gap-4" data-testid="loop-reads">
      {groups.length === 0 ? (
        <p className="text-sm text-ink-muted">No read actions are offered yet.</p>
      ) : null}
      {groups.map((g) => (
        <fieldset key={g.key} className="min-w-0">
          <legend className="mb-1.5 text-sm font-medium text-ink">
            {g.name}{" "}
            <span className="font-normal text-ink-muted">
              {g.type === "connector" ? "connector" : "area"}
            </span>
          </legend>
          <ul className="flex flex-col gap-1">
            {g.actions.map((a) => (
              <li key={a.id}>
                <label className="flex items-start gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 accent-slate"
                    data-testid={`loop-read-${a.id}`}
                    checked={picked.has(a.id)}
                    onChange={() => toggle(a.id)}
                  />
                  <span className="min-w-0">
                    {a.label} <span className="reference text-ink-muted">{a.id}</span>
                    <span className="block text-ink-muted">{a.description}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      ))}
      {stray.map((id) => (
        <label key={id} className="flex items-center gap-2 text-sm text-risk">
          <input
            type="checkbox"
            className="size-4 accent-slate"
            checked
            onChange={() => toggle(id)}
          />
          <span className="reference">{id}</span> isn't an action a Loop can read with. Untick it.
        </label>
      ))}
      {error ? <p className="ds-error text-sm">{error}</p> : null}
    </div>
  );
}
