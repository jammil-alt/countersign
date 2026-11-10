// The Builder beside the workflow builder (prototype `#O6-Builder`; ARCHITECTURE §9.6): a
// conversation about this agent's draft. The conversation keeps its own working draft on the
// server, so the canvas and the conversation are kept the same: a turn starts from what the
// canvas shows (unsaved edits are saved as a draft version first, and a new conversation starts
// from it when the canvas moved on), and the Builder's draft comes back onto the canvas as one
// undoable edit. Nothing is saved as a version here: the operator saves, test-runs and publishes
// as before. "Save as automation" turns the selected steps into an automation draft the same way.
import {
  type AnyAgentBundle,
  AnyAgentBundle as AnyAgentBundleSchema,
  canonicalJson,
  type ProcessAgentBundle,
  Slug,
} from "@countersign/core";
import { useState } from "react";
import type { ResponseOf } from "../../api/client";
import { type AgentSummary, apiRoutes } from "../../api/routes";
import { Button } from "../../ui/primitives";
import { slugify } from "../agents/definition-form";
import { errorText, isCode, Notice, useAction } from "../agents/ui";
import { BuilderMark, Composer, Turns } from "./chat";
import { SmallInput } from "./fields";

type Detail = ResponseOf<typeof apiRoutes.opsBuilderSession>;

// R8: the conversation's draft may be a v3 bundle (the Builder drafts v3 until it learns v4); it
// comes onto the canvas read as processes (`read`), so the two compare like with like.
function parsed(detail: Detail | null): AnyAgentBundle | null {
  if (!detail) return null;
  const p = AnyAgentBundleSchema.safeParse(detail.session.bundle);
  return p.success ? p.data : null;
}

export interface BuilderSession {
  detail: Detail | null;
  /** The canvas shows exactly the conversation's draft. */
  inSync: boolean;
  busy: boolean;
  error: unknown;
  pending: string | null;
  send(text: string): Promise<boolean>;
  undo(turnId: string, changeId: string): Promise<void>;
  saveAutomation(stepIds: string[], name: string, slug: string): Promise<boolean>;
}

export function useBuilderSession({
  agent,
  bundle,
  read,
  ensureSaved,
  onDraft,
}: {
  agent: AgentSummary;
  /** What the canvas shows now. */
  bundle: ProcessAgentBundle;
  /** A draft as the canvas shows it (v3 workflows read as processes, ids kept). */
  read(bundle: AnyAgentBundle): ProcessAgentBundle;
  /** The version the canvas is saved as, saving unsaved edits first; null when saving failed. */
  ensureSaved(): Promise<{ id: string } | null>;
  /** The conversation's draft, onto the canvas. */
  onDraft(bundle: ProcessAgentBundle): void;
}): BuilderSession {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const action = useAction();
  const raw = parsed(detail);
  const draft = raw ? read(raw) : null;
  const inSync = draft !== null && canonicalJson(draft) === canonicalJson(bundle);

  const take = (next: Detail) => {
    setDetail(next);
    const p = parsed(next);
    const b = p ? read(p) : null;
    if (b && canonicalJson(b) !== canonicalJson(bundle)) onDraft(b);
  };

  /** The conversation to talk in: this one while the canvas matches it, else a new one. */
  async function sessionId(): Promise<string | null> {
    if (detail && inSync) return detail.session.id;
    const from = await ensureSaved();
    if (!from) return null;
    const res = await action.call(apiRoutes.opsStartBuilderSession, {
      body: { kind: "agent", agentId: agent.id, fromVersionId: from.id },
    });
    if (!res.ok) return null;
    setDetail(res.data);
    return res.data.session.id;
  }

  return {
    detail,
    inSync,
    busy: action.busy,
    error: action.error,
    pending,
    async send(text) {
      setPending(text);
      const id = await sessionId();
      if (!id) {
        setPending(null);
        return false;
      }
      const res = await action.call(apiRoutes.opsBuilderTurn, { params: { id }, body: { text } });
      setPending(null);
      if (!res.ok) return false;
      take(res.data);
      return true;
    },
    async undo(turnId, changeId) {
      if (!detail || !inSync) return;
      const res = await action.call(apiRoutes.opsBuilderUndo, {
        params: { id: detail.session.id },
        body: { turnId, changeId },
      });
      if (res.ok) take(res.data);
    },
    async saveAutomation(stepIds, name, slug) {
      const id = await sessionId();
      if (!id) return false;
      const res = await action.call(apiRoutes.opsBuilderSaveAutomation, {
        params: { id },
        body: { stepIds, name, slug },
      });
      if (!res.ok) return false;
      take(res.data);
      return true;
    },
  };
}

/** The right rail's Builder tab. */
export function BuilderPanel({ session }: { session: BuilderSession }) {
  const turns = session.detail?.turns ?? [];
  return (
    <div className="flex h-full flex-col" data-testid="builder-chat">
      <div className="flex items-center justify-between gap-3 pb-4">
        <span className="flex items-center gap-2.5 type-subheading text-ink">
          <BuilderMark />
          Builder
        </span>
        <span className="text-sm text-ink-muted">Edits this draft</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pb-4">
        <Turns
          turns={turns}
          busy={session.busy}
          pending={session.pending}
          {...(session.inSync ? { onUndo: session.undo } : {})}
          undoOff="You've changed the workflow since. Undo it on the canvas."
          empty={
            <p className="text-sm text-ink-muted" data-testid="builder-chat-empty">
              Ask for a step, a fork or a rule, or ask why something is there. The Builder changes
              this draft on the canvas, each change with its own Undo. Approval stays on for every
              step that changes a tool; only you can switch it off.
            </p>
          }
        />
        {session.error ? (
          <Notice tone="warning" testId="builder-chat-error">
            {isCode(session.error, "builder_unavailable")
              ? `The Builder can't reach its model right now. ${errorText(session.error)}`
              : errorText(session.error)}
          </Notice>
        ) : null}
      </div>
      <Composer
        testId="builder-chat-composer"
        placeholder="Add a step, change a rule, or ask why"
        busy={session.busy}
        onSend={session.send}
      />
    </div>
  );
}

/** "2 selected · Save as automation": the steps become an automation draft, used in their place. */
export function SaveAsAutomation({
  count,
  busy,
  onSave,
  onClear,
}: {
  count: number;
  busy: boolean;
  onSave(name: string, slug: string): Promise<boolean>;
  onClear(): void;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const slug = slugify(name);
  const invalid = !name.trim() || !Slug.safeParse(slug).success;
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-md border border-slate bg-slate-tint px-3 py-2"
      data-testid="builder-selection"
    >
      <span className="text-sm font-medium text-slate">{count} selected</span>
      {naming ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (invalid) return;
            if (await onSave(name.trim(), slug)) {
              setNaming(false);
              setName("");
            }
          }}
        >
          <SmallInput
            aria-label="Automation name"
            data-testid="builder-automation-name"
            className="w-56"
            placeholder="Find and match a receipt"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button
            type="submit"
            className="ds-btn ds-btn--primary ds-btn--sm"
            data-testid="builder-automation-save"
            disabled={invalid || busy}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </form>
      ) : (
        <Button
          variant="primary"
          size="sm"
          data-testid="builder-save-automation"
          onClick={() => setNaming(true)}
        >
          Save as automation
        </Button>
      )}
      <Button variant="ghost" size="sm" onClick={onClear}>
        Clear
      </Button>
    </div>
  );
}
