// v0.17 O6 (ARCHITECTURE §10.15 "Home", docs/plan.md §1.96): Sloan's chat beside any portal
// screen. The Sloan button at the top right opens it as a side sheet over the page: the person's
// latest conversation (or a new one), their earlier ones to pick up again, and the full history at
// /sloan. Home's cards open it with a question ready ("@Pia ", "Tell me more about Sales").

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

interface PanelState {
  open: boolean;
  /** A conversation picked from the history; null: the newest. */
  threadId: string | null;
  /** Text to put in the box when the panel opens. */
  prefill: string;
  /** Bumped on each open, so the box takes a new prefill. */
  key: number;
}

interface PanelApi {
  open(prefill?: string): void;
  close(): void;
}

const PanelContext = createContext<PanelApi | null>(null);

/** Opens and closes Sloan's panel; a no-op outside the portal (tests that render one screen). */
export function useSloanPanel(): PanelApi {
  return useContext(PanelContext) ?? { open: () => {}, close: () => {} };
}

export function SloanPanelProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PanelState>({
    open: false,
    threadId: null,
    prefill: "",
    key: 0,
  });
  const open = useCallback(
    (prefill = "") => setState((s) => ({ ...s, open: true, prefill, key: s.key + 1 })),
    [],
  );
  const close = useCallback(() => setState((s) => ({ ...s, open: false })), []);
  const api = useMemo(() => ({ open, close }), [open, close]);
  return (
    <PanelContext.Provider value={api}>
      {children}
      {state.open ? (
        <SloanPanel
          key={state.key}
          threadId={state.threadId}
          prefill={state.prefill}
          onPick={(threadId) => setState((s) => ({ ...s, threadId, key: s.key + 1, prefill: "" }))}
          onClose={close}
        />
      ) : null}
    </PanelContext.Provider>
  );
}

function SloanPanel({
  threadId,
  prefill,
  onPick,
  onClose,
}: {
  threadId: string | null;
  prefill: string;
  onPick: (threadId: string | null) => void;
  onClose: () => void;
}) {
  const { t, fmt } = useI18n();
  const api = useApiClient();
  const threads = useApi(apiRoutes.portalThreads, { query: { subject: "account" } });
  const list = [...(threads.data?.threads ?? [])].sort(
    (a, b) =>
      Date.parse(b.lastMessageAt ?? b.createdAt) - Date.parse(a.lastMessageAt ?? a.createdAt),
  );
  const [fresh, setFresh] = useState(false);
  const current = fresh ? null : (threadId ?? list[0]?.id ?? null);

  async function start(): Promise<string | null> {
    const { thread } = await api.call(apiRoutes.portalStartThread, {
      body: { subject: "account" },
    });
    threads.reload();
    return thread.id;
  }

  return (
    <SideSheet
      title={t("sloan.title")}
      eyebrow={<AgentBadge name="Sloan" size="sm" />}
      onClose={onClose}
      testId="portal-sloan-panel"
      tabs={
        <div className="flex flex-wrap items-center gap-2 px-6 pb-3">
          {list.length > 0 ? (
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
              {fresh ? <option value="">{t("sloanPanel.new")}</option> : null}
              {list.map((th) => (
                <option key={th.id} value={th.id}>
                  {fmt.date(th.lastMessageAt ?? th.createdAt)}
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
