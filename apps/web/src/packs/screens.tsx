// Pack screens in both shells (ARCHITECTURE §15): the portal mounts a pack's reports from the
// registry (./registry.ts); the back office's Packs page lists the deployment's packs and switches
// one on for a client, so that client's agents can use its tools and skills; the client page shows
// the same switch and links to that client's reports. Packs ship no agents (docs/plan.md §1.63):
// agents are built in the Agent lab, so a pack's template list is usually empty.
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { ResponseOf } from "../api/client";
import { apiRoutes } from "../api/routes";
import { useApi, useApiClient } from "../api/useApi";
import { entityWords } from "../ops/builder/data-use";
import { ClientFrame } from "../ops/client/ClientFrame";
import { toolLine, toolName } from "../ops/library/plain";
import { shortTime } from "../runs/format";
import { connectorLabel } from "../runs/labels";
import {
  Badge,
  Button,
  Card,
  cx,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  SectionLabel,
  Tag,
} from "../ui/primitives";
import { SheetSection, SideSheet } from "../ui/sheet";
import { BankTransactionsView } from "./bookkeeping/BankTransactions";
import { ReconciliationsView } from "./bookkeeping/Reconciliations";
import { CatalogView, PackReportLinks, PriceWatchView } from "./materials/Reports";
// P-9
import { RequestsView, RequestView } from "./materials/Requests";
// §1.88
import { MasterItemView, VendorCatalogView } from "./materials/VendorCatalog";
import { PackGate } from "./PackGate";

// ── Portal ───────────────────────────────────────────────────────────────────────────────────────

export const PortalPriceWatchScreen = () => <PriceWatchView />;
// §1.88: the catalog, or one master item's page (its vendors side by side) when the route names it.
export function PortalCatalogScreen() {
  const { id } = useParams();
  return id ? <MasterItemView /> : <CatalogView />;
}
// §1.88: the vendor catalog, read only; `…/vendor-catalog/:id` opens that vendor.
export const PortalVendorCatalogScreen = () => <VendorCatalogView />;
// P-9: the list, or one request's page when the route names it.
export function PortalRequestsScreen() {
  const { id } = useParams();
  return id ? <RequestView /> : <RequestsView />;
}

// B-6 (docs/plan.md §1.79): the Bookkeeping area's Bank transactions.
export const PortalBankTransactionsScreen = () => <BankTransactionsView />;
// R-1 (docs/plan.md §1.80): Reconciliations.
export const PortalReconciliationsScreen = () => <ReconciliationsView />;

// ── Back office ──────────────────────────────────────────────────────────────────────────────────

// A client's pack pages sit in the client page's Packs tab (../ops/client/ClientFrame.tsx).
export function OpsClientPacksScreen() {
  const { clientId = "" } = useParams();
  return (
    <ClientFrame clientId={clientId}>
      <ClientPacks clientId={clientId} />
    </ClientFrame>
  );
}

export function OpsClientPriceWatchScreen() {
  const { clientId = "" } = useParams();
  return (
    <ClientFrame clientId={clientId}>
      <PackGate clientId={clientId} pack="materials">
        <PriceWatchView clientId={clientId} />
      </PackGate>
    </ClientFrame>
  );
}

export function OpsClientCatalogScreen() {
  const { clientId = "", id } = useParams();
  return (
    <ClientFrame clientId={clientId}>
      <PackGate clientId={clientId} pack="materials">
        {id ? <MasterItemView clientId={clientId} /> : <CatalogView clientId={clientId} />}
      </PackGate>
    </ClientFrame>
  );
}

// §1.88: a client's vendor catalog, with the operator's actions.
export function OpsClientVendorCatalogScreen() {
  const { clientId = "" } = useParams();
  return (
    <ClientFrame clientId={clientId}>
      <PackGate clientId={clientId} pack="materials">
        <VendorCatalogView clientId={clientId} />
      </PackGate>
    </ClientFrame>
  );
}

// P-9: a client's purchase requests and one request's page (docs/plan.md §1.71).
export function OpsClientRequestsScreen() {
  const { clientId = "" } = useParams();
  return (
    <ClientFrame clientId={clientId}>
      <PackGate clientId={clientId} pack="materials">
        <RequestsView clientId={clientId} />
      </PackGate>
    </ClientFrame>
  );
}

export function OpsClientRequestScreen() {
  const { clientId = "" } = useParams();
  return (
    <ClientFrame clientId={clientId}>
      <PackGate clientId={clientId} pack="materials">
        <RequestView clientId={clientId} />
      </PackGate>
    </ClientFrame>
  );
}

// B-6: a client's bank transactions, with its account links, rules and chart of accounts.
export function OpsClientBankTransactionsScreen() {
  const { clientId = "" } = useParams();
  return (
    <ClientFrame clientId={clientId}>
      <PackGate clientId={clientId} pack="bookkeeping">
        <BankTransactionsView clientId={clientId} />
      </PackGate>
    </ClientFrame>
  );
}

// R-1: a client's reconciliations.
export function OpsClientReconciliationsScreen() {
  const { clientId = "" } = useParams();
  return (
    <ClientFrame clientId={clientId}>
      <PackGate clientId={clientId} pack="bookkeeping">
        <ReconciliationsView clientId={clientId} />
      </PackGate>
    </ClientFrame>
  );
}

/** P-9: the back office's "Import bill prices": every synced QuickBooks bill in a range. */
function ImportBillPrices({ clientId }: { clientId: string }) {
  const client = useApiClient();
  const year = new Date().getUTCFullYear();
  const [from, setFrom] = useState(`${year - 1}-01-01`);
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Record<string, unknown> | null>(null);
  const [problem, setProblem] = useState<unknown>(null);
  return (
    <div className="mt-4 flex flex-col gap-2" data-testid={`ops-import-bill-prices-${clientId}`}>
      <SectionLabel>Prices from QuickBooks bills</SectionLabel>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="date"
          className="ds-input"
          aria-label="From"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <input
          type="date"
          className="ds-input"
          aria-label="To"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
        <Button
          size="sm"
          data-testid="ops-import-bill-prices"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setProblem(null);
            try {
              const res = await client.call(apiRoutes.opsClientPackAction, {
                params: { id: clientId, pack: "materials", action: "import-bill-prices" },
                body: { from, to },
              });
              setDone(res.result);
            } catch (e) {
              setProblem(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          Import bill prices
        </Button>
      </div>
      {done ? (
        <p className="text-sm text-ink" data-testid="ops-import-bill-prices-done">
          {`Recorded ${String(done.recorded)} prices from ${String(done.bills)} bills; ${String(done.needsReview)} lines to review.`}
          {done.more ? " There are more bills: run it again." : ""}
        </p>
      ) : null}
      {problem ? <ErrorNotice error={problem} /> : null}
    </div>
  );
}

function EnableButton({
  clientId,
  pack,
  onDone,
}: {
  clientId: string;
  pack: string;
  onDone: (installed: string[]) => void;
}) {
  const client = useApiClient();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  return (
    <span className="flex items-center gap-2">
      {problem ? <ErrorNotice error={problem} /> : null}
      <Button
        size="sm"
        variant="primary"
        data-testid={`pack-enable-${pack}-${clientId}`}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setProblem(null);
          try {
            const res = await client.call(apiRoutes.opsEnableClientPack, {
              params: { id: clientId, pack },
            });
            onDone(res.installed.map((i) => i.slug));
          } catch (e) {
            setProblem(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        Switch on
      </Button>
    </span>
  );
}

/**
 * Wave 3b: gives a pack's installed templates the later versions the pack carries. Each client
 * agent forked from one is then offered the update, which the operator reviews as a merge.
 */
function UpdateTemplatesButton({ pack, onDone }: { pack: string; onDone: (note: string) => void }) {
  const client = useApiClient();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  return (
    <span className="flex items-center gap-2">
      {problem ? <ErrorNotice error={problem} /> : null}
      <Button
        size="sm"
        variant="secondary"
        data-testid={`pack-update-templates-${pack}`}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setProblem(null);
          try {
            const res = await client.call(apiRoutes.opsUpdatePackTemplates, { params: { pack } });
            const live = res.updated.filter((u) => u.published);
            const held = res.updated.filter((u) => !u.published);
            const parts = [
              live.length > 0
                ? `Published ${live.map((u) => `${u.slug} v${u.version}`).join(", ")}. Its clients are offered the update to review.`
                : null,
              held.length > 0
                ? `Saved ${held.map((u) => `${u.slug} v${u.version}`).join(", ")} as a draft beside your own live version.`
                : null,
            ].filter((x): x is string => x !== null);
            onDone(parts.length > 0 ? parts.join(" ") : "The templates are up to date.");
          } catch (e) {
            setProblem(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        Update templates
      </Button>
    </span>
  );
}

type PackInfo = ResponseOf<typeof apiRoutes.opsPacks>["packs"][number];

const EFFECT_WORDS: Record<PackInfo["tools"][number]["sideEffect"], string> = {
  none: "Reads",
  internal: "Keeps records",
  external: "Writes to the client's tools",
};

/**
 * The deployment's packs as a list; a pack's details open beside it: what it keeps for each
 * client, which clients have it on (and the switch), its templates, reports, tools and skills.
 */
export function OpsPacksScreen() {
  const { data, error, loading, reload } = useApi(apiRoutes.opsPacks);
  const [installed, setInstalled] = useState<string[]>([]);
  const [updated, setUpdated] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return null;
  const open = data.packs.find((p) => p.id === openId) ?? null;
  return (
    <div data-testid="ops-packs">
      <PageHeader
        title="Packs"
        subtitle="The data and tools for one business area. Switch a pack on for a client so its agents can keep that data and use those tools."
      />
      {installed.length > 0 ? (
        <p className="mb-4 text-sm text-ink" data-testid="ops-packs-installed">
          Installed {installed.join(", ")} as templates.
        </p>
      ) : null}
      {updated ? (
        <p className="mb-4 text-sm text-ink" data-testid="ops-packs-updated">
          {updated}
        </p>
      ) : null}
      {data.packs.length === 0 ? (
        <EmptyState>This deployment has no packs.</EmptyState>
      ) : (
        <Card>
          <div className="dt dt-ana overflow-x-auto">
            <table data-testid="ops-packs-table">
              <thead>
                <tr className="dt-cols">
                  <th>Pack</th>
                  <th className="text-right">Clients on</th>
                  <th className="text-right">Templates</th>
                  <th className="text-right">Reports</th>
                  <th className="text-right">Tools</th>
                  <th>Version</th>
                </tr>
              </thead>
              <tbody>
                {data.packs.map((p) => {
                  const on = p.clients.filter((c) => c.enabled).length;
                  return (
                    <tr
                      key={p.id}
                      data-testid={`ops-pack-${p.id}`}
                      aria-selected={p.id === openId}
                      className={cx(p.id === openId && "bg-slate-tint")}
                    >
                      <td>
                        <button
                          type="button"
                          className="group flex flex-col text-left"
                          aria-haspopup="dialog"
                          data-testid={`ops-pack-${p.id}-open`}
                          onClick={() => setOpenId(p.id)}
                        >
                          <span className="font-medium text-ink group-hover:underline">
                            {p.name}
                          </span>
                          <span className="max-w-xl text-sm text-ink-muted">
                            {firstSentence(p.description)}
                          </span>
                        </button>
                      </td>
                      <td className="text-right figures" data-testid={`ops-pack-${p.id}-on`}>
                        {on} of {p.clients.length}
                      </td>
                      <td className="text-right figures">{p.templates.length}</td>
                      <td className="text-right figures">{p.screens.length}</td>
                      <td className="text-right figures">{p.tools.length}</td>
                      <td className="reference text-ink-muted">v{p.version}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {open ? (
        <PackPanel
          key={open.id}
          pack={open}
          onClose={() => setOpenId(null)}
          onInstalled={(slugs) => {
            setInstalled(slugs);
            reload();
          }}
          onUpdated={(note) => {
            setUpdated(note);
            reload();
          }}
        />
      ) : null}
    </div>
  );
}

function firstSentence(text: string): string {
  const at = text.indexOf(". ");
  return at > 0 ? text.slice(0, at + 1) : text;
}

function PackPanel({
  pack: p,
  onClose,
  onInstalled,
  onUpdated,
}: {
  pack: PackInfo;
  onClose: () => void;
  onInstalled: (slugs: string[]) => void;
  onUpdated: (note: string) => void;
}) {
  return (
    <SideSheet
      testId="ops-pack-panel"
      onClose={onClose}
      eyebrow={<span className="reference text-ink-muted">v{p.version}</span>}
      title={p.name}
    >
      <p className="text-ink">{p.description}</p>
      {p.records.length > 0 ? (
        <SheetSection label="What it keeps for each client">
          <p className="text-sm text-ink" data-testid="ops-pack-panel-records">
            {sentenceCase(p.records.map(entityWords).join(", "))}.
          </p>
          <p className="text-sm text-ink-muted">
            Each client's records are their own and never shared. They fill as the client's agents
            work and as you import.
          </p>
        </SheetSection>
      ) : null}
      <SheetSection label="Clients">
        <ul className="flex flex-col divide-y divide-line">
          {p.clients.map((c) => (
            <li
              key={c.id}
              className="flex items-center justify-between gap-3 py-2 text-sm"
              data-testid={`ops-pack-client-${c.id}`}
            >
              <Link to={`/ops/clients/${c.id}`} className="text-ink hover:underline">
                {c.name}
              </Link>
              {c.enabled ? (
                <Badge tone="positive">On since {shortTime(c.enabledAt)}</Badge>
              ) : (
                <EnableButton clientId={c.id} pack={p.id} onDone={onInstalled} />
              )}
            </li>
          ))}
        </ul>
      </SheetSection>
      {p.requiresConnectors.length > 0 ? (
        <SheetSection label="Needs connected">
          <p className="text-sm text-ink">{p.requiresConnectors.map(connectorLabel).join(", ")}</p>
        </SheetSection>
      ) : null}
      {p.templates.length > 0 ? (
        <SheetSection label="Templates">
          <ul className="flex flex-col gap-1.5">
            {p.templates.map((t) => (
              <li key={t.slug} className="flex flex-wrap items-center gap-2 text-sm">
                {t.templateId ? (
                  <Link to={`/ops/templates/${t.slug}`} className="text-ink hover:underline">
                    {t.name}
                  </Link>
                ) : (
                  <span className="text-ink">{t.name}</span>
                )}
                <Badge tone={t.templateId ? "positive" : "neutral"}>
                  {t.templateId ? "Installed" : "Installs when switched on"}
                </Badge>
                {t.newVersions > 0 ? (
                  <Badge tone="warning">
                    {t.newVersions === 1 ? "1 newer version" : `${t.newVersions} newer versions`}
                  </Badge>
                ) : null}
              </li>
            ))}
          </ul>
          {p.templates.some((t) => t.newVersions > 0) ? (
            <div className="mt-1">
              <UpdateTemplatesButton pack={p.id} onDone={onUpdated} />
            </div>
          ) : null}
        </SheetSection>
      ) : null}
      {p.screens.length > 0 ? (
        <SheetSection label="Reports in the client's portal">
          <p className="text-sm text-ink">{p.screens.map((s) => s.title).join(", ")}</p>
        </SheetSection>
      ) : null}
      {p.tools.length > 0 ? (
        <SheetSection label={`Tools · ${p.tools.length}`}>
          <ul className="flex flex-col divide-y divide-line" data-testid="ops-pack-panel-tools">
            {p.tools.map((t) => (
              <li key={t.id} className="flex items-start justify-between gap-3 py-2 text-sm">
                <span className="flex flex-col">
                  <span className="text-ink">{toolName(t.id)}</span>
                  <span className="text-ink-muted">{toolLine(t)}</span>
                </span>
                <Tag>{EFFECT_WORDS[t.sideEffect]}</Tag>
              </li>
            ))}
          </ul>
        </SheetSection>
      ) : null}
      {p.skills.length > 0 ? (
        <SheetSection label={`Skills · ${p.skills.length}`}>
          <p className="text-sm text-ink">{p.skills.map((k) => k.name).join(", ")}</p>
        </SheetSection>
      ) : null}
    </SideSheet>
  );
}

const sentenceCase = (s: string) => (s ? s[0]?.toUpperCase() + s.slice(1) : s);

/** The client page's packs: which are on, switch one on, and that client's reports. */
export function ClientPacks({ clientId }: { clientId: string }) {
  const { data, error, reload } = useApi(apiRoutes.opsClientPacks, { params: { id: clientId } });
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  if (data.packs.length === 0) return <EmptyState>This deployment has no packs.</EmptyState>;
  return (
    <section data-testid="ops-client-packs">
      <div className="flex flex-col gap-3">
        {data.packs.map((p) => (
          <Card key={p.id} className="p-5" testId={`ops-client-pack-${p.id}`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-medium text-ink">{p.name}</p>
                <p className="text-sm text-ink-muted">{p.description}</p>
              </div>
              {p.enabled ? (
                <Badge tone="positive">On</Badge>
              ) : (
                <EnableButton clientId={clientId} pack={p.id} onDone={() => reload()} />
              )}
            </div>
            {p.enabled && p.screens.length > 0 ? (
              <div className="mt-4">
                <PackReportLinks screens={p.screens} base={`/ops/clients/${clientId}`} />
              </div>
            ) : null}
            {/* P-9 */}
            {p.enabled && p.id === "materials" ? <ImportBillPrices clientId={clientId} /> : null}
          </Card>
        ))}
      </div>
    </section>
  );
}
