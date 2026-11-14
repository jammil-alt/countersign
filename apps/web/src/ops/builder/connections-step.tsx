// A step's connections in the inspector (owner, 2026-11-14): "Prior step" and "Next step", filled
// with the steps it is connected to now. Picking another one checks the move first
// (`assessReconnect`): a move that breaks nothing is made at once and says so; one that would
// leave a step without data it needs says what, and offers a place where the step fits, a Reshape
// step to fill the inputs, the move as asked, or keeping things as they are.
import { type TypingContext, uuidv7 } from "@countersign/core";
import { useState } from "react";
import { Button } from "../../ui/primitives";
import type { BuilderProblem } from "./catalog";
import {
  type Assessment,
  assessReconnect,
  ISSUE_TITLE,
  neighbours,
  type Place,
  type Reconnect,
  reconnect,
  reconnectWithReshape,
} from "./connections";
import { Row, SmallSelect } from "./fields";
import {
  type ContainerId,
  ifOfBranch,
  locate,
  moveStep,
  type Process,
  ROOT,
  type Step,
} from "./model";
import { fieldLabel } from "./problems";

/** The select's value for "none": the start of the list, or its end. */
const NONE = "";

export interface ConnectionsProps {
  step: Step;
  workflow: Process;
  ctx: TypingContext;
  /** The builder's validator on this workflow as `p` would leave it, in plain words. */
  assess(p: Process): BuilderProblem[];
  /** One edit of the process, one undo. */
  onProcess(fn: (w: Process) => Process, key: string): void;
}

interface Pending {
  change: Reconnect;
  result: Assessment;
}

type Notice = { tone: "done" | "kept"; text: string };

function stepLabel(container: ContainerId, siblings: Step[], s: Step): string {
  const name = s.name || "Untitled step";
  return container === ROOT ? `${siblings.indexOf(s) + 1} · ${name}` : name;
}

function placeText(p: Pick<Place, "prior" | "next">): string {
  if (p.prior && p.next) return `between “${p.prior.name}” and “${p.next.name}”`;
  if (p.prior) return `after “${p.prior.name}”, last`;
  if (p.next) return `first, before “${p.next.name}”`;
  return "on its own";
}

export function ConnectionsSection({ step, workflow, ctx, assess, onProcess }: ConnectionsProps) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const n = neighbours(workflow, step.id);
  if (!n) return null;
  const others = n.siblings.filter((s) => s.id !== step.id);
  const atRoot = n.container === ROOT;

  const choose = (end: Reconnect["end"], value: string) => {
    const change: Reconnect = { end, to: value === NONE ? null : value };
    const result = assessReconnect(workflow, step.id, change, assess);
    if (!result) {
      setPending(null);
      return;
    }
    if (result.added.length === 0) {
      onProcess((w) => reconnect(w, step.id, change), `${step.id}:connect:${uuidv7()}`);
      setPending(null);
      const moved = neighbours(result.process, step.id);
      const cleared = result.cleared.length;
      setNotice({
        tone: "done",
        text: `Moved ${moved ? placeText(moved) : ""}. We checked every step: none loses data it needs${
          cleared ? `, and it clears ${cleared === 1 ? "1 problem" : `${cleared} problems`}` : ""
        }.`,
      });
      return;
    }
    setNotice(null);
    setPending({ change, result });
  };

  const applyFit = (p: Place) => {
    onProcess((w) => {
      const now = neighbours(w, step.id);
      return now ? moveStep(w, step.id, now.container, p.index) : w;
    }, `${step.id}:connect:${uuidv7()}`);
    setPending(null);
    setNotice({ tone: "done", text: `Moved ${placeText(p)}, where nothing breaks.` });
  };

  const applyAnyway = (p: Pending) => {
    onProcess((w) => reconnect(w, step.id, p.change), `${step.id}:connect:${uuidv7()}`);
    setPending(null);
    setNotice({
      tone: "kept",
      text: "Moved. The problems it makes show on their steps and in the problems list, each with Fix.",
    });
  };

  const applyReshape = (p: Pending) => {
    // One new id per Reshape step, the same however often the edit is applied.
    const made = p.result.reshape.map(() => uuidv7());
    const before = p.result.reshape.map((s) => s.id);
    onProcess((w) => {
      let i = 0;
      const ids = () => made[i++] ?? uuidv7();
      return reconnectWithReshape(w, step.id, p.change, before, ctx, ids);
    }, `${step.id}:connect:${uuidv7()}`);
    setPending(null);
    setNotice({
      tone: "done",
      text: `Moved, with a Reshape step before ${p.result.reshape.map((s) => `“${s.name}”`).join(" and ")}. Its mapping is proposed from what runs before: check it before you publish.`,
    });
  };

  const priorValue =
    pending?.change.end === "prior" ? (pending.change.to ?? NONE) : (n.prior?.id ?? NONE);
  const nextValue =
    pending?.change.end === "next" ? (pending.change.to ?? NONE) : (n.next?.id ?? NONE);

  return (
    <section
      className="flex flex-col gap-3 border-t border-line pt-4"
      data-testid="builder-connections"
    >
      <h3 className="eyebrow text-ink-muted">Connections</h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Row label="Prior step">
          <SmallSelect
            data-testid="builder-connection-prior"
            value={priorValue}
            disabled={others.length === 0}
            onChange={(e) => choose("prior", e.target.value)}
          >
            <option value={NONE}>
              {atRoot ? "None: runs first, after the trigger" : "None: runs first here"}
            </option>
            {others.map((s) => (
              <option key={s.id} value={s.id}>
                {stepLabel(n.container, n.siblings, s)}
              </option>
            ))}
          </SmallSelect>
        </Row>
        <Row label="Next step">
          <SmallSelect
            data-testid="builder-connection-next"
            value={nextValue}
            disabled={others.length === 0}
            onChange={(e) => choose("next", e.target.value)}
          >
            <option value={NONE}>{atRoot ? "None: runs last" : "None: runs last here"}</option>
            {others.map((s) => (
              <option key={s.id} value={s.id}>
                {stepLabel(n.container, n.siblings, s)}
              </option>
            ))}
          </SmallSelect>
        </Row>
      </div>
      {atRoot ? null : (
        <p className="text-xs text-ink-muted">
          These are the steps on this step's own path. Drag it on the canvas to put it on another.
        </p>
      )}

      {pending ? (
        <Review
          pending={pending}
          onFit={applyFit}
          onReshape={() => applyReshape(pending)}
          onAnyway={() => applyAnyway(pending)}
          onKeep={() => {
            setPending(null);
            setNotice({ tone: "kept", text: "Kept as it was." });
          }}
        />
      ) : null}
      {notice ? (
        <p
          role="status"
          data-testid="builder-connection-notice"
          className={
            notice.tone === "done"
              ? "rounded-sm border border-positive-tint bg-positive-tint px-3.5 py-3 text-sm text-positive"
              : "rounded-sm border border-line bg-surface-subtle px-3.5 py-3 text-sm text-ink"
          }
        >
          {notice.text}
        </p>
      ) : null}
    </section>
  );
}

function Review({
  pending,
  onFit,
  onReshape,
  onAnyway,
  onKeep,
}: {
  pending: Pending;
  onFit(p: Place): void;
  onReshape(): void;
  onAnyway(): void;
  onKeep(): void;
}) {
  const { result } = pending;
  const count = result.added.reduce((t, g) => t + g.problems.length, 0);
  const names = (stepId: string | null) =>
    stepId ? (findName(result.process, stepId) ?? "a step") : "the workflow";
  return (
    <div
      className="flex flex-col gap-3 border-l-2 border-signal pl-3"
      data-testid="builder-connection-review"
    >
      <p className="text-sm text-ink">
        <span className="font-medium">Needs your call:</span> this connection would make{" "}
        {count === 1 ? "1 problem" : `${count} problems`}.
        {result.cleared.length
          ? ` It would also clear ${result.cleared.length === 1 ? "1" : result.cleared.length}.`
          : ""}
      </p>
      {result.added.map((g) => (
        <div
          key={g.kind}
          className="flex flex-col gap-1"
          data-testid={`builder-connection-issue-${g.kind}`}
        >
          <p className="text-sm font-medium text-ink">{ISSUE_TITLE[g.kind]}</p>
          <ul className="flex flex-col gap-1 text-sm text-ink">
            {g.problems.map((e) => (
              <li key={`${e.stepId}:${e.field}:${e.code}:${e.message}`}>
                <span className="font-medium">{names(e.stepId)}</span>
                {fieldLabel(e.field) ? ` · ${fieldLabel(e.field)}` : ""}: {e.message}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div className="flex flex-col gap-2">
        <p className="eyebrow text-ink-muted">Ways to resolve it</p>
        {result.fits.slice(0, 3).map((p) => (
          <div key={p.index}>
            <Button
              variant="secondary"
              size="sm"
              data-testid={`builder-connection-fit-${p.index}`}
              onClick={() => onFit(p)}
            >
              Put it {placeText(p)} instead
            </Button>
          </div>
        ))}
        {result.reshape.length ? (
          <div>
            <Button
              variant="secondary"
              size="sm"
              data-testid="builder-connection-reshape"
              onClick={onReshape}
            >
              Connect it and add a Reshape step before{" "}
              {result.reshape.map((s) => `“${s.name}”`).join(" and ")}
            </Button>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            size="sm"
            data-testid="builder-connection-anyway"
            onClick={onAnyway}
          >
            Connect anyway and fix each
          </Button>
          <Button variant="ghost" size="sm" data-testid="builder-connection-keep" onClick={onKeep}>
            Keep it as it was
          </Button>
        </div>
      </div>
    </div>
  );
}

function findName(process: Process, stepId: string): string | null {
  return (locate(process, stepId)?.step ?? ifOfBranch(process, stepId))?.name ?? null;
}
