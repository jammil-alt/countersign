// v0.17 O6–O7 (ARCHITECTURE §10.15 "Home", "Talking to an owner", docs/plan.md §1.96): the chat
// beside any portal screen. The Sloan button at the top right opens the person's latest
// conversation with Sloan; "Ask Pia" opens their conversation with Pia, one of their agents. The
// head always says who you are talking to (name, role, and that it is a Mezonas agent), so nobody
// takes an agent for a person or one agent for another. Earlier conversations can be picked up,
// and the full history is at /sloan.

import { OWNER_WORDS, type PortalThread } from "@countersign/core";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { apiRoutes } from "../api/routes";
import { useApi, useApiClient } from "../api/useApi";
import { useI18n } from "../i18n/i18n";
import { AgentBadge } from "../ui/badges";
import { Select } from "../ui/forms";
import { Button } from "../ui/primitives";
import { SideSheet } from "../ui/sheet";
import { PORTAL_PATHS } from "./paths";
import { Conversation } from "./screens/Sloan";

/** Who the panel opens on, and with what in the box. */
export interface PanelOpen {
  /** One of the client's agents (an area owner); absent: Sloan. */
  ownerId?: string | undefined;
  prefill?: string | undefined;
}

interface PanelState {
  open: boolean;
  /** A conversation picked from the history; null: the newest with whoever it opened on. */
  threadId: string | null;
  ownerId: string | null;
  prefill: string;
  /** Bumped on each open, so the box takes a new prefill. */
  key: number;
}

interface PanelApi {
  open(what?: string | PanelOpen): void;
  close(): void;
}

const PanelContext = createContext<PanelApi | null>(null);

/** Opens and closes the chat panel; a no-op outside the portal (tests that render one screen). */
export function useSloanPanel(): PanelApi {
  return useContext(PanelContext) ?? { open: () => {}, close: () => {} };
}

export function SloanPanelProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PanelState>({
    open: false,
    threadId: null,
    ownerId: null,
    prefill: "",
    key: 0,
  });
  const open = useCallback((what: string | PanelOpen = {}) => {
    const o: PanelOpen = typeof what === "string" ? { prefill: what } : what;
    setState((s) => ({
      open: true,
      threadId: null,
      ownerId: o.ownerId ?? null,
      prefill: o.prefill ?? "",
      key: s.key + 1,
    }));
  }, []);
  const close = useCallback(() => setState((s) => ({ ...s, open: false })), []);
  const api = useMemo(() => ({ open, close }), [open, close]);
  return (
    <PanelContext.Provider value={api}>
      {children}
      {state.open ? (
        <SloanPanel
          key={state.key}
          threadId={state.threadId}
          ownerId={state.ownerId}
          prefill={state.prefill}
          onPick={(threadId) => setState((s) => ({ ...s, threadId, key: s.key + 1, prefill: "" }))}
          onClose={close}
        />
      ) : null}
    </PanelContext.Provider>
  );
}

/** When a conversation was last active, newest first. */
const lastActive = (t: PortalThread) => Date.parse(t.lastMessageAt ?? t.createdAt);

function SloanPanel({
  threadId,
  ownerId,
  prefill,
  onPick,
  onClose,
}: {
  threadId: string | null;
  ownerId: string | null;
  prefill: string;
  onPick: (threadId: string | null) => void;
  onClose: () => void;
}) {
  const { t, fmt, locale } = useI18n();
  const api = useApiClient();
  const words = OWNER_WORDS[locale] ?? OWNER_WORDS.en;
  const threads = useApi(apiRoutes.portalThreads, { query: { subject: "account" } });
  const all = [...(threads.data?.threads ?? [])].sort((a, b) => lastActive(b) - lastActive(a));
  const [fresh, setFresh] = useState(false);
  // The conversation shown: the one picked, else the newest with whoever the panel opened on.
  const picked = threadId ? all.find((th) => th.id === threadId) : undefined;
  const withWhom = picked ? (picked.owner?.id ?? null) : ownerId;
  const newest = all.find((th) => (th.owner?.id ?? null) === withWhom);
  const current = fresh ? null : (picked?.id ?? newest?.id ?? null);
  const shown = current ? all.find((th) => th.id === current) : undefined;
  // Who the person is talking to: the conversation's agent, else whoever the panel opened on
  // (from the client's agents, before a first conversation with it exists).
  const listed = useApi(apiRoutes.owners, withWhom ? {} : null);
  const fromList = listed.data?.owners.find((o) => o.id === withWhom);
  const owner =
    shown?.owner ??
    (withWhom ? all.find((th) => th.owner?.id === withWhom)?.owner : null) ??
    (fromList ? { name: fromList.name, role: words.role(words.functionOf[fromList.area]) } : null);
  const name = owner?.name ?? t("sloan.title");
  const role = owner?.role ?? words.assistant;

  async function start(): Promise<string | null> {
    const { thread } = await api.call(apiRoutes.portalStartThread, {
      body: { subject: "account", ...(withWhom ? { ownerId: withWhom } : {}) },
    });
    threads.reload();
    return thread.id;
  }

  return (
    <SideSheet
      title={name}
      eyebrow={
        <span className="flex items-center gap-2" data-testid="portal-sloan-panel-who">
          <AgentBadge name={name} size="sm" />
          <span className="text-sm text-ink-muted">
            {role} · {words.agentNote}
          </span>
        </span>
      }
      onClose={onClose}
      testId="portal-sloan-panel"
      tabs={
        <div className="flex flex-wrap items-center gap-2 px-6 pb-3">
          {all.length > 0 ? (
            <Select
              aria-label={t("sloan.past")}
              data-testid="portal-sloan-panel-history"
              className="w-auto"
              value={current ?? ""}
              onChange={(e) => {
                setFresh(false);
                onPick(e.target.value || null);
              }}
            >
              {fresh || !current ? <option value="">{t("sloanPanel.new")}</option> : null}
              {all.map((th) => (
                <option key={th.id} value={th.id}>
                  {`${th.owner?.name ?? t("sloan.title")} · ${fmt.date(th.lastMessageAt ?? th.createdAt)}`}
                </option>
              ))}
            </Select>
          ) : null}
          <Button size="sm" data-testid="portal-sloan-panel-new" onClick={() => setFresh(true)}>
            {t("sloanPanel.new")}
          </Button>
          <Link
            to={current ? `${PORTAL_PATHS.sloan}/${current}` : PORTAL_PATHS.sloan}
            className="text-sm"
            onClick={onClose}
            data-testid="portal-sloan-panel-full"
          >
            {t("sloanPanel.full")}
          </Link>
        </div>
      }
    >
      <Conversation
        threadId={current}
        start={start}
        prefill={prefill}
        onStarted={(id) => {
          setFresh(false);
          onPick(id);
        }}
      />
    </SideSheet>
  );
}
