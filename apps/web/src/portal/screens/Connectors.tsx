// `/connectors`, Connectors (Connectors C5, docs/connectors-plan.md §3.1; replaces Accounts and its
// vault rail): the tools the client's agents work in. A needs banner (signal, with words) when an
// agent waits on something; Connected, a row per connection with its account, state, the agents
// using it and its access in a line; Built for you, the connectors made for this client alone, the
// websites an agent signs in to for them (the vault's logins) and Ask for a connector; Browse,
// every live connector, recommended first, grouped by kind, with a search. Each opens its page.
import {
  type ConnectorCardView,
  connectorAccessRoutes,
  type NeedsBannerItem,
} from "@countersign/core";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { PortalScriptsCard } from "../../accounts/scripts";
import { VaultCard } from "../../accounts/vault";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { ConnectorMark, connectionStatusLabel } from "../../connections/ConnectorMark";
import {
  CONNECTOR_GROUPS,
  type ConnectorGroup,
  connectorGroup,
  GROUP_KEY,
} from "../../connections/groups";
import { useI18n } from "../../i18n/i18n";
import { useSession } from "../../session/session";
import { Field, TextArea, TextInput } from "../../ui/forms";
import { Icon } from "../../ui/icons";
import { Loaded, Page, Section } from "../../ui/page";
import { Badge, Button, EmptyState, PageHeader, Tag } from "../../ui/primitives";
import { RequestAction } from "../../ui/RequestAction";
import { StatusChip } from "../../ui/status";
import { accessSummary, descriptionOf, HOW_KEY, isBroken, STATUS_CHIP } from "../connectors/words";
import { PORTAL_PATHS } from "../paths";

// Website logins are connections of the browser connector, one per site: they are Built for you's
// logins, never a tool of their own. Upload is built in: it lives on the agents that read documents.
const HIDDEN = new Set(["browser", "upload"]);

/** Brings a part of the page into view (`#vault`: the website logins). */
function scrollToId(id: string) {
  document.getElementById(id)?.scrollIntoView?.({ behavior: "smooth", block: "start" });
}

function useIsAdmin(): boolean {
  const session = useSession();
  const role =
    session.tenants.find((c) => c.id === session.activeTenantId)?.role ??
    session.tenants[0]?.role ??
    "client_user";
  return role === "client_admin";
}

export function ConnectorsScreen() {
  const { t } = useI18n();
  const isAdmin = useIsAdmin();
  const location = useLocation();
  const list = useApi(connectorAccessRoutes.portalConnectors);
  const vault = useApi(apiRoutes.portalAccess, {
    // The vault is never stored (docs/audit-plan.md 1.2).
    cache: "none",
  });
  const [adding, setAdding] = useState<boolean | null>(null);

  const vaultLoaded = vault.data !== undefined;
  useEffect(() => {
    // `/accounts#vault` and `/access` land here with `#vault`: bring the website logins into view.
    if (location.hash === "#vault" && vaultLoaded) scrollToId("vault");
  }, [location.hash, vaultLoaded]);

  const reloadAll = () => {
    list.reload();
    vault.reload();
  };

  // The vault's logins with no row of their own here: website logins, and any key whose tool
  // isn't listed under Connected.
  const listed = new Set(
    (list.data?.connected ?? []).flatMap((c) => c.connections.map((x) => x.id)),
  );
  const logins =
    vault.data?.items.filter(
      (i) =>
        i.connector !== "upload" &&
        (i.kind === "browser" || i.kind === "api_key") &&
        !listed.has(i.connectionId),
    ) ?? [];
  const offers = vault.data?.canEdit ? vault.data.browserSites.length + vault.data.setup.length : 0;
  // Open the add panel at first when there are no logins yet and something to set up.
  const addOpen = adding ?? (vault.data !== undefined && logins.length === 0 && offers > 0);

  return (
    <Page testId="portal-connectors">
      <PageHeader title={t("nav.connectors")} subtitle={t("connectors.subtitle")} />
      <Loaded state={list}>
        {(data) => (
          <>
            <NeedsBanner waiting={data.waiting} openRequests={data.openRequests} />
            <Section title={t("connectors.connected.title")} testId="connectors-connected">
              <Connected cards={data.connected.filter((c) => !HIDDEN.has(c.connector))} />
            </Section>
            <Section
              title={t("connectors.built.title")}
              meta={t("connectors.built.meta")}
              testId="connectors-built"
            >
              <div className="ui-cols ui-cols--3">
                {data.builtForYou
                  .filter((c) => !HIDDEN.has(c.connector))
                  .map((c) => (
                    <Tile key={c.connector} card={c} waiting={data.waiting} />
                  ))}
                <AskForConnector />
              </div>
              <div id="vault" className="scroll-mt-24">
                <Loaded state={vault}>
                  {(view) =>
                    logins.length > 0 || offers > 0 ? (
                      <VaultCard
                        view={view}
                        items={logins}
                        adding={addOpen}
                        title={t("connectors.logins.title")}
                        subtitle={t("connectors.logins.subtitle")}
                        onAdding={setAdding}
                        onChanged={reloadAll}
                      />
                    ) : (
                      <span />
                    )
                  }
                </Loaded>
              </div>
              {/* Wave 4: scripts on the website logins (the client admin records; we publish). */}
              {isAdmin ? <PortalScriptsCard /> : null}
            </Section>
            <Browse cards={data.browse} waiting={data.waiting} />
            {/* Request an action (docs/step-model-plan.md §10c): what they need, in their words. */}
            <Section title={t("requestAction.title")} testId="connectors-request-action">
              <RequestAction
                as="client"
                words={{
                  open: t("requestAction.title"),
                  label: t("requestAction.label"),
                  hint: t("requestAction.hint"),
                  send: t("requestAction.send"),
                  cancel: t("requestAction.cancel"),
                  thanks: t("requestAction.thanks"),
                  another: t("requestAction.another"),
                }}
                testId="request-action"
              />
            </Section>
          </>
        )}
      </Loaded>
    </Page>
  );
}

/** Agents waiting on the client: signal, always with words; each opens the page with it picked. */
function NeedsBanner({
  waiting,
  openRequests,
}: {
  waiting: NeedsBannerItem[];
  openRequests: number;
}) {
  const { t } = useI18n();
  if (waiting.length === 0 && openRequests === 0) return null;
  const agents = [...new Map(waiting.map((w) => [w.agent.id, w.agent.name])).values()];
  return (
    <div
      className="flex flex-col gap-3 rounded-md border border-line bg-signal-tint p-4 text-signal-ink"
      data-testid="connectors-needs"
    >
      {waiting.length > 0 ? (
        <div>
          <strong>
            {agents.length === 1
              ? t("connectors.needs.one", { agent: agents[0] ?? "", count: waiting.length })
              : t("connectors.needs.many", { count: agents.length })}
          </strong>
          <ul className="mt-1 list-disc pl-5">
            {waiting.map((w) => (
              <li key={`${w.agent.id}-${w.connector}-${w.kind}`}>
                <Link
                  className="underline"
                  to={PORTAL_PATHS.connector(w.connector, w.agent.id)}
                  data-testid={`connectors-need-${w.agent.id}-${w.connector}`}
                >
                  {w.words}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {openRequests > 0 ? (
        <p data-testid="connectors-open-requests">
          {t("connectors.needs.requests", { count: openRequests })}{" "}
          <Link className="underline" to={PORTAL_PATHS.inbox}>
            {t("connectors.needs.toInbox")}
          </Link>
        </p>
      ) : null}
    </div>
  );
}

/** A row per connection: mark, name, account, who uses it, its access in a line, its state. */
function Connected({ cards }: { cards: ConnectorCardView[] }) {
  const i18n = useI18n();
  const { t } = i18n;
  const rows = cards.flatMap((card) => card.connections.map((c) => ({ card, c })));
  if (rows.length === 0) return <EmptyState>{t("connectors.connected.none")}</EmptyState>;
  return (
    <div
      className="divide-y divide-line overflow-hidden rounded-md border border-line bg-surface"
      data-testid="connectors-connected-list"
    >
      {rows.map(({ card, c }) => {
        const broken = isBroken(c.status);
        const line = [
          c.accountName,
          c.usedBy.length > 0
            ? t("connectors.usedByLine", { names: c.usedBy.map((a) => a.name).join(", ") })
            : null,
          accessSummary(c.access, i18n),
        ].filter((x): x is string => !!x);
        return (
          <Link
            key={c.id}
            to={PORTAL_PATHS.connector(card.connector)}
            className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-surface-subtle"
            data-testid={`connectors-row-${card.connector}`}
          >
            <ConnectorMark name={card.name} connector={card.connector} />
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-ink">{card.name}</span>
              <span className="block text-sm text-ink-muted">{line.join(" · ")}</span>
            </span>
            {c.openRequest ? (
              <Badge tone="warning" testId="connectors-row-request">
                {t("connectors.row.request")}
              </Badge>
            ) : null}
            {c.needsSomething ? (
              <Badge tone="warning" testId="connectors-row-needs">
                {t("connectors.row.needsSomething")}
              </Badge>
            ) : null}
            {broken ? (
              <Badge tone="risk" testId="connectors-row-status">
                {t("connectors.signInAgain")}
              </Badge>
            ) : (
              <StatusChip state={STATUS_CHIP[c.status] ?? "idle"} testId="connectors-row-status">
                {connectionStatusLabel(c.status, i18n)}
              </StatusChip>
            )}
          </Link>
        );
      })}
    </div>
  );
}

/** A connector as a tile: mark, name, one line, how it connects, and who needs it. */
function Tile({ card, waiting }: { card: ConnectorCardView; waiting: NeedsBannerItem[] }) {
  const i18n = useI18n();
  const { t } = i18n;
  const needers = waiting.filter((w) => w.connector === card.connector);
  const forAgent = needers[0]?.agent.id ?? null;
  return (
    <Link
      to={PORTAL_PATHS.connector(card.connector, forAgent)}
      className="flex items-start gap-3 rounded-md border border-line bg-surface p-4 hover:border-line-strong"
      data-testid={`connectors-tile-${card.connector}`}
    >
      <ConnectorMark name={card.name} connector={card.connector} />
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-2 font-medium text-ink">
          {card.name}
          {card.beta ? <Tag testId="connectors-tile-beta">{t("connectors.beta")}</Tag> : null}
        </span>
        <span className="mt-0.5 block text-sm text-ink-muted">{descriptionOf(card, i18n)}</span>
        <span className="mt-2 block text-xs text-ink-muted">
          {card.connections.length > 0 ? t("connectors.tile.connected") : t(HOW_KEY[card.auth])}
          {needers.length > 0 ? (
            <>
              {" · "}
              <span className="text-signal-ink" data-testid="connectors-tile-needed">
                {t("connectors.row.needs", {
                  names: [...new Set(needers.map((n) => n.agent.name))].join(", "),
                })}
              </span>
            </>
          ) : null}
        </span>
      </span>
    </Link>
  );
}

/**
 * Ask for a connector: a tool we don't list goes to the client's lead as a Request (§1.124), with
 * what the agent should do there.
 */
function AskForConnector() {
  const { t } = useI18n();
  const api = useApiClient();
  const [open, setOpen] = useState(false);
  const [tool, setTool] = useState("");
  const [what, setWhat] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [sent, setSent] = useState<string | null>(null);

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!tool.trim() || !what.trim()) return;
    setBusy(true);
    setFailed(false);
    try {
      const res = await api.call(apiRoutes.portalRaiseRequest, {
        body: {
          kind: "idea",
          subject: t("connectors.ask.subject", { tool: tool.trim() }).slice(0, 200),
          text: what.trim(),
        },
      });
      setSent(res.item.id);
      setTool("");
      setWhat("");
      setOpen(false);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="flex items-start gap-3 rounded-md border border-dashed border-line-strong bg-surface p-4 text-left hover:border-slate"
        data-testid="connectors-ask"
        onClick={() => setOpen(true)}
      >
        <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-sm border border-line bg-surface-subtle text-ink">
          <Icon name="add" size={20} />
        </span>
        <span className="min-w-0">
          <span className="block font-medium text-ink">{t("connectors.ask.title")}</span>
          <span className="mt-0.5 block text-sm text-ink-muted">{t("connectors.ask.help")}</span>
          {sent ? (
            <Link
              to={PORTAL_PATHS.request(sent)}
              className="mt-2 block text-sm text-link hover:underline"
              data-testid="connectors-ask-sent"
              onClick={(e) => e.stopPropagation()}
            >
              {t("connectors.ask.sent")}
            </Link>
          ) : (
            <span className="mt-2 block text-xs text-copper-ink">{t("connectors.ask.lead")}</span>
          )}
        </span>
      </button>
    );
  }
  return (
    <form
      className="flex flex-col gap-3 rounded-md border border-line bg-surface p-4"
      data-testid="connectors-ask-form"
      onSubmit={(e) => void send(e)}
    >
      <p className="font-medium text-ink">{t("connectors.ask.title")}</p>
      <Field label={t("connectors.ask.tool")}>
        <TextInput
          value={tool}
          maxLength={120}
          onChange={(e) => setTool(e.target.value)}
          data-testid="connectors-ask-tool"
        />
      </Field>
      <Field label={t("connectors.ask.what")}>
        <TextArea
          rows={3}
          value={what}
          onChange={(e) => setWhat(e.target.value)}
          data-testid="connectors-ask-what"
        />
      </Field>
      {failed ? <p className="text-sm text-risk">{t("requests.failed")}</p> : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => setOpen(false)}>
          {t("common.cancel")}
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={!tool.trim() || !what.trim()}
          working={busy}
          data-testid="connectors-ask-send"
        >
          {t("connectors.ask.send")}
        </Button>
      </div>
    </form>
  );
}

/** A card's group for Browse: the API's, when it is one we name; else by connector, as before. */
function groupOf(card: ConnectorCardView): ConnectorGroup {
  const g = card.group.toLowerCase();
  return (CONNECTOR_GROUPS as readonly string[]).includes(g)
    ? (g as ConnectorGroup)
    : connectorGroup(card.connector);
}

/** Every live connector: Recommended for you first, then by kind; a search narrows them. */
function Browse({ cards, waiting }: { cards: ConnectorCardView[]; waiting: NeedsBannerItem[] }) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const words = q.trim().toLowerCase();
    return cards.filter(
      (c) =>
        !HIDDEN.has(c.connector) &&
        !c.custom &&
        (!words ||
          c.name.toLowerCase().includes(words) ||
          c.description.toLowerCase().includes(words)),
    );
  }, [cards, q]);
  const recommended = q ? [] : shown.filter((c) => c.recommended);
  const rest = q ? shown : shown.filter((c) => !c.recommended);
  const groups = CONNECTOR_GROUPS.map((group) => ({
    group,
    items: rest.filter((c) => groupOf(c) === group),
  })).filter((g) => g.items.length > 0);
  return (
    <Section
      title={t("connectors.browse.title")}
      action={
        <TextInput
          type="search"
          value={q}
          placeholder={t("connectors.browse.search")}
          aria-label={t("connectors.browse.search")}
          onChange={(e) => setQ(e.target.value)}
          className="max-w-60"
          data-testid="connectors-search"
        />
      }
      testId="connectors-browse"
    >
      {shown.length === 0 ? (
        <EmptyState>{q ? t("connectors.browse.noMatch") : t("connectors.browse.none")}</EmptyState>
      ) : null}
      {recommended.length > 0 ? (
        <div data-testid="connectors-group-recommended" className="flex flex-col gap-3">
          <h3 className="eyebrow text-ink-muted">{t("connectors.browse.recommended")}</h3>
          <div className="ui-cols ui-cols--3">
            {recommended.map((c) => (
              <Tile key={c.connector} card={c} waiting={waiting} />
            ))}
          </div>
        </div>
      ) : null}
      {groups.map(({ group, items }) => (
        <div key={group} data-testid={`connectors-group-${group}`} className="flex flex-col gap-3">
          <h3 className="eyebrow text-ink-muted">{t(GROUP_KEY[group])}</h3>
          <div className="ui-cols ui-cols--3">
            {items.map((c) => (
              <Tile key={c.connector} card={c} waiting={waiting} />
            ))}
          </div>
        </div>
      ))}
    </Section>
  );
}
