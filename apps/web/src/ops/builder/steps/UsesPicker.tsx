// The Uses picker (§5): "QuickBooks › Create bill", "Purchasing › Register lines", a skill, an
// automation, Match, Collect reports, Tell, or nothing yet. What is offered depends on Done by.

import { useState } from "react";
import { SmallInput } from "../fields";
import { type UsesContext, type UsesOption, usesGroups, usesKey, usesLabel } from "./options";
import type { DoneBy, DoStep, Uses } from "./types";

/** Groups that are not a connector or an area: their options read without a heading. */
const PLAIN_GROUPS = new Set(["Built in", "Skills", "Automations"]);

export interface UsesPickerProps {
  doneBy: DoneBy | undefined;
  step: Pick<DoStep, "uses">;
  ctx: UsesContext;
  onPick(uses: Uses | undefined): void;
}

export function UsesPicker({ doneBy, step, ctx, onPick }: UsesPickerProps) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const groups = usesGroups(doneBy, ctx)
    .map((g) => ({
      ...g,
      options: g.options.filter((o) =>
        `${g.heading} ${o.label}`.toLowerCase().includes(q.trim().toLowerCase()),
      ),
    }))
    .filter((g) => g.options.length > 0);
  const current = usesKey(step.uses);
  const pick = (o: UsesOption | undefined) => {
    onPick(o?.uses);
    setOpen(false);
    setQ("");
  };
  return (
    <div className="flex flex-col gap-1.5" data-testid="uses-picker">
      <button
        type="button"
        aria-expanded={open}
        aria-label="What it uses"
        className="ds-select flex h-9 w-full items-center justify-between text-left text-sm"
        onClick={() => setOpen(!open)}
      >
        <span>{usesLabel(step, ctx)}</span>
      </button>
      {open ? (
        <div className="flex flex-col gap-1 border border-line bg-surface p-2">
          <SmallInput
            aria-label="Search what it uses"
            placeholder="Search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="max-h-72 overflow-y-auto">
            <button
              type="button"
              className="w-full px-2 py-1 text-left text-sm hover:bg-surface-subtle"
              onClick={() => pick(undefined)}
            >
              Nothing yet
            </button>
            {groups.map((g) => (
              <fieldset key={g.heading} className="contents">
                <legend className="sr-only">{g.heading}</legend>
                <div className="eyebrow px-2 pt-2 text-ink-muted">{g.heading}</div>
                {g.options.map((o) => (
                  <button
                    key={o.key}
                    type="button"
                    aria-current={o.key === current || undefined}
                    className="flex w-full flex-col px-2 py-1 text-left text-sm hover:bg-surface-subtle"
                    onClick={() => pick(o)}
                  >
                    <span className="text-ink">
                      {PLAIN_GROUPS.has(g.heading) ? o.label : `${g.heading} › ${o.label}`}
                    </span>
                    {o.hint ? <span className="text-xs text-ink-muted">{o.hint}</span> : null}
                  </button>
                ))}
              </fieldset>
            ))}
            {groups.length === 0 ? (
              <p className="px-2 py-1 text-sm text-ink-muted">Nothing matches.</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
