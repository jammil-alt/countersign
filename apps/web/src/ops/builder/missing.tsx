// v0.18 (owner, 2026-11-15; docs/plan.md §1.103): the inspector for a missing step, and each
// step's "Data" section. A missing step holds a piece the Builder couldn't build where it belongs;
// the inspector says what is missing in the Builder's sentence and offers what already exists to
// fix it: draft the skill with the Builder (ARCHITECTURE §9.6 "Draft the new skill"), replace it
// with a step from the palette (keeping its id, so later steps' references follow), or remove it.
// Signal (gold) is "waiting on you", always with its word.

import type { processes } from "@countersign/core";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../../ui/icons";
import { Badge, Button, buttonClass } from "../../ui/primitives";
import { SmallInput } from "./fields";

type MissingStep = processes.MissingStep;

const FILL_WORDS: Record<processes.MissingFill, string> = {
  skill: "A skill would fill it.",
  tool: "A tool would fill it: one the client's connected tools offer.",
  connector: "A connector would fill it: the client connects the tool it needs.",
};

export interface MissingActions {
  /** Starts a Builder conversation drafting a skill for it (absent: not offered). */
  onDraftSkill?: ((step: MissingStep) => void) | undefined;
  /** Opens the palette: the step picked there takes this one's place and id. */
  onReplace?: ((id: string) => void) | undefined;
  onDelete(id: string): void;
  /** A client agent's client: where a connector would be connected. */
  tenantId?: string | null | undefined;
  /** Whether a skill draft is being started. */
  drafting?: boolean | undefined;
  /** `panel` (F6): the side panel shows the step's name and Remove itself. */
  layout?: "panel" | undefined;
}

export function MissingFields(
  props: MissingActions & {
    step: MissingStep;
    eyebrow: string;
    onName(name: string): void;
  },
) {
  const { step } = props;
  const skillFills = step.fill === undefined || step.fill === "skill";
  const panel = props.layout === "panel";
  return (
    <div className="flex flex-col gap-4" data-testid="builder-missing">
      <div className="mb-0">
        {panel ? null : (
          <>
            <p className="eyebrow text-ink-muted">{props.eyebrow}</p>
            <h2 className="mt-1 type-heading text-ink">{step.name || "Missing step"}</h2>
          </>
        )}
        <p className={panel ? "text-sm text-ink" : "mt-2 text-sm text-ink"}>
          A piece the Builder couldn't build yet, kept where it belongs. It never runs: fill it or
          remove it before this can be published. A draft with it can be saved.
        </p>
      </div>
      <div
        data-testid="builder-missing-need"
        className="flex flex-col gap-1.5 rounded-md border border-signal bg-signal-tint px-3 py-2 text-sm text-signal-ink"
      >
        <span>
          <Badge tone="warning">Missing</Badge>
        </span>
        <span className="text-ink">{step.need}</span>
        {step.fill ? <span className="text-ink-muted">{FILL_WORDS[step.fill]}</span> : null}
      </div>
      {panel ? null : (
        <label htmlFor="builder-missing-name" className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink">What the step would do</span>
          <SmallInput
            data-field="name"
            id="builder-missing-name"
            data-testid="builder-inspector-name"
            value={step.name}
            onChange={(e) => props.onName(e.target.value)}
          />
        </label>
      )}
      <section className="flex flex-col gap-2 border-t border-line pt-4">
        <h3 className="eyebrow text-ink-muted">Fill it</h3>
        {skillFills && props.onDraftSkill ? (
          <FillRow
            hint="The Builder drafts the skill from this step's need, with tests. Once it is published, replace this step with it."
            action={
              <Button
                data-testid="builder-missing-draft-skill"
                disabled={props.drafting}
                onClick={() => props.onDraftSkill?.(step)}
              >
                {props.drafting ? "Starting…" : "Draft the skill"}
              </Button>
            }
          />
        ) : null}
        {step.fill === "connector" && props.tenantId ? (
          <FillRow
            hint="Connect the tool for the client, then replace this step with one that uses it."
            action={
              <Link
                to={`/ops/clients/${props.tenantId}/connections`}
                className={buttonClass("secondary")}
                data-testid="builder-missing-connections"
              >
                Open connections
              </Link>
            }
          />
        ) : null}
        {props.onReplace ? (
          <FillRow
            hint="Pick a skill, a tool or any other step: it takes this step's place, and later steps keep reading it."
            action={
              <Button
                data-testid="builder-missing-replace"
                onClick={() => props.onReplace?.(step.id)}
              >
                <Icon name="add" />
                Replace with a step
              </Button>
            }
          />
        ) : null}
      </section>
      {panel ? null : (
        <div className="flex justify-end border-t border-line pt-4">
          <Button
            variant="ghost"
            data-testid="builder-inspector-delete"
            onClick={() => props.onDelete(step.id)}
          >
            Remove it
          </Button>
        </div>
      )}
    </div>
  );
}

function FillRow({ hint, action }: { hint: string; action: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <p className="min-w-0 text-sm text-ink-muted">{hint}</p>
      <span className="shrink-0">{action}</span>
    </div>
  );
}

/** A step's data in the inspector: what it reads and saves, and what the client lacks for it. */
export function DataSection({ lines, warnings }: { lines: string[]; warnings: string[] }) {
  if (lines.length === 0 && warnings.length === 0) return null;
  return (
    <section className="flex flex-col gap-2 border-t border-line pt-4" data-testid="builder-data">
      <h3 className="eyebrow text-ink-muted">Data</h3>
      <ul className="flex flex-col gap-1 text-sm text-ink">
        {lines.map((l) => (
          <li key={l} data-testid="builder-data-line">
            {l}
          </li>
        ))}
      </ul>
      {warnings.length > 0 ? (
        <ul className="flex flex-col gap-1 text-sm">
          {warnings.map((w) => (
            <li
              key={w}
              data-testid="builder-data-warning"
              className="flex items-start gap-2 text-ink"
            >
              <Badge tone="warning" className="shrink-0">
                Needs
              </Badge>
              <span>{w}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
