// The Builder beside the step builder (feedback, 2026-11-26: "Where is the builder? There is no
// builder in this screen. How do I engage it?"). The v4 builder's conversation went with it (#707);
// this is the same conversation on a step-model draft: a turn starts from what the chart shows
// (unsaved edits are saved as a draft version first, and the conversation carries on from it, with
// its turns, when the chart moved on), and the Builder's draft of this workflow comes back onto the chart as one
// undoable edit. Nothing is published here: the operator saves, tries and publishes as before.
// The conversation outlives a reload: its id is kept for the browser session, per agent.
// DECISION: only this workflow comes back from the Builder's draft. A workflow it adds or changes
// elsewhere in the agent is in the conversation's draft, for the operator to open from the Build
// tab; the chart shows one workflow and its undo covers one.
import { canonicalJson, steps } from "@countersign/core";
import { useEffect, useState } from "react";
import type { ResponseOf } from "../../../api/client";
import { type AgentSummary, apiRoutes } from "../../../api/routes";
import { useApiClient } from "../../../api/useApi";
import { Icon } from "../../../ui/icons";
import { Button } from "../../../ui/primitives";
import { errorText, isCode, Notice, useAction } from "../../agents/ui";
import { BuilderMark, Composer, Turns } from "../chat";
import type { Workflow } from "./types";

type Detail = ResponseOf<typeof apiRoutes.opsBuilderSession>;

const CHAT_PREFIX = "countersign:builder-chat:";

function rememberedChat(agentId: string): string | null {
  try {
    return window.sessionStorage.getItem(`${CHAT_PREFIX}${agentId}`);
  } catch {
    return null;
  }
}

function rememberChat(agentId: string, sessionId: string | null) {
  try {
    if (sessionId) window.sessionStorage.setItem(`${CHAT_PREFIX}${agentId}`, sessionId);
    else window.sessionStorage.removeItem(`${CHAT_PREFIX}${agentId}`);
  } catch {
    // Storage may be blocked; the conversation then lasts as long as the page.
  }
}

/** This workflow in the conversation's draft, if it reads in the step model. */
export function draftWorkflow(detail: Detail | null, slug: string): Workflow | null {
  const b = detail?.session.bundle as { workflows?: { slug: string; workflow: unknown }[] } | null;
  const entry = b?.workflows?.find((w) => w.slug === slug);
  if (!entry) return null;
  const p = steps.Workflow.safeParse(entry.workflow);
  return p.success ? p.data : null;
}

export interface BuilderSession {
  detail: Detail | null;
  /** The chart shows exactly the conversation's draft of this workflow. */
  inSync: boolean;
  busy: boolean;
  error: unknown;
  pending: string | null;
  send(text: string, options?: { focusStepId?: string | undefined }): Promise<boolean>;
  undo(turnId: string, changeId: string): Promise<void>;
}

export function useBuilderSession({
  agent,
  slug,
  workflow,
  ensureSaved,
  onDraft,
}: {
  agent: AgentSummary;
  slug: string;
  /** What the chart shows now. */
  workflow: Workflow;
  /** The version the chart is saved as, saving unsaved edits first; null when saving failed. */
  ensureSaved(): Promise<{ id: string } | null>;
  /** The conversation's draft of this workflow, onto the chart. */
  onDraft(next: Workflow): void;
}): BuilderSession {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const action = useAction();
  const api = useApiClient();

  // biome-ignore lint/correctness/useExhaustiveDependencies: read once per agent.
  useEffect(() => {
    const id = rememberedChat(agent.id);
    if (!id) return;
    let live = true;
    api
      .call(apiRoutes.opsBuilderSession, { params: { id } })
      .then((out) => {
        if (!live) return;
        if (out.session.status === "open") setDetail((now) => now ?? out);
        else rememberChat(agent.id, null);
      })
      .catch(() => rememberChat(agent.id, null));
    return () => {
      live = false;
    };
  }, [agent.id]);
  useEffect(() => {
    if (detail) rememberChat(agent.id, detail.session.id);
  }, [agent.id, detail]);

  const draft = draftWorkflow(detail, slug);
  const inSync = draft !== null && canonicalJson(draft) === canonicalJson(workflow);

  const take = (next: Detail) => {
    setDetail(next);
    const w = draftWorkflow(next, slug);
    if (w && canonicalJson(w) !== canonicalJson(workflow)) onDraft(w);
  };

  /**
   * The conversation to talk in: this one, brought up to the chart when the chart moved on (it is
   * saved, and the conversation carries on from that version with all its turns); a new one only
   * when there is none yet (feedback, 2026-11-26: the history was lost on every edit).
   */
  async function sessionId(): Promise<string | null> {
    if (detail && inSync) return detail.session.id;
    const from = await ensureSaved();
    if (!from) return null;
    if (detail && detail.session.status === "open") {
      const synced = await action.call(apiRoutes.opsSyncBuilderSession, {
        params: { id: detail.session.id },
        body: { fromVersionId: from.id },
      });
      if (!synced.ok) return null;
      setDetail(synced.data);
      return synced.data.session.id;
    }
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
    async send(text, options) {
      setPending(text);
      const id = await sessionId();
      if (!id) {
        setPending(null);
        return false;
      }
      const focusStepId = options?.focusStepId;
      const res = await action.call(apiRoutes.opsBuilderTurn, {
        params: { id },
        body: { text, ...(focusStepId ? { focusStepId } : {}) },
      });
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
  };
}

/** The Builder's conversation, in the side drawer. */
export function BuilderChat({
  session,
  focus,
  prefill,
  onClose,
}: {
  session: BuilderSession;
  /** The step open when the Builder was asked: each turn is about it until it is cleared. */
  focus?: { id: string; name: string } | null;
  /** Words for the box (an issue to fix), changed each time the host asks; sent by the person. */
  prefill?: { text: string; n: number } | null;
  onClose(): void;
}) {
  const turns = session.detail?.turns ?? [];
  const [about, setAbout] = useState(focus ?? null);
  // Another step opened beside it (Next, Previous): the conversation is about that one now.
  const focusId = focus?.id ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: follows the open step by its id.
  useEffect(() => {
    if (focusId) setAbout(focus ?? null);
  }, [focusId]);
  return (
    <aside aria-label="Builder" className="flex h-full min-h-0 flex-col" data-testid="builder-chat">
      <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="flex flex-col gap-1">
          <span className="flex items-center gap-2.5 type-subheading text-ink">
            <BuilderMark />
            Builder
          </span>
          <span className="text-sm text-ink-muted">
            It changes this draft on the chart, each change with its own Undo.
          </span>
        </div>
        <Button
          variant="ghost"
          className="ds-btn--icon shrink-0"
          aria-label="Close"
          data-testid="builder-chat-close"
          onClick={onClose}
        >
          <Icon name="close" size={20} />
        </Button>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
        <Turns
          turns={turns}
          thread={{ stepId: about?.id ?? null }}
          busy={session.busy}
          pending={session.pending}
          {...(session.inSync ? { onUndo: session.undo } : {})}
          undoOff="You've changed the workflow since. Undo it on the chart."
          empty={
            <p className="text-sm text-ink-muted" data-testid="builder-chat-empty">
              Ask for a step, a fork or a rule, or ask why something is there. Approval stays on for
              every step that changes a tool; only you can switch it off.
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
      <div className="flex flex-col gap-2 border-t border-line px-5 py-3">
        {about ? (
          <div className="flex items-center gap-2 text-xs text-ink-muted">
            <span data-testid="builder-chat-focus">On “{about.name || "this step"}”</span>
            <button type="button" className="underline" onClick={() => setAbout(null)}>
              The whole workflow
            </button>
          </div>
        ) : null}
        <Composer
          key={prefill?.n ?? 0}
          initialText={prefill?.text ?? ""}
          testId="builder-chat-composer"
          placeholder="Add a step, change a rule, or ask why"
          busy={session.busy}
          onSend={(text) => session.send(text, about ? { focusStepId: about.id } : undefined)}
          clientId={session.detail?.session.clientId}
        />
      </div>
    </aside>
  );
}
