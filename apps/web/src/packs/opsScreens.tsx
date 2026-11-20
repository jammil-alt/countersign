// Pack screens in the back office (ARCHITECTURE §15): the Packs page lists the deployment's packs
// and switches one on for a client, so that client's agents can use its tools and skills; the
// client page's Areas tab (§1.162) shows the same switch and links to that client's reports. Packs ship no agents
// (docs/plan.md §1.63): agents are built in the Agent lab, so a pack's template list is usually
// empty. The portal's pack screens are in ./screens.tsx; these stay out of the portal's first load.
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiRoutes } from "../api/routes";
import { useApi, useApiClient } from "../api/useApi";
import { ClientFrame } from "../ops/client/ClientFrame";
import { shortTime } from "../runs/format";
import {
  Badge,
  Button,
  Card,
  ErrorNotice,
  Loading,
  PageHeader,
  SectionLabel,
} from "../ui/primitives";
import { BankTransactionsView } from "./bookkeeping/BankTransactions";
import { ReconciliationsView } from "./bookkeeping/Reconciliations";
import { CatalogView, PriceWatchView } from "./materials/Reports";
// P-9
import { RequestsView, RequestView } from "./materials/Requests";
// §1.88
import { MasterItemView, VendorCatalogView } from "./materials/VendorCatalog";
import { PackGate } from "./PackGate";

// ── Back office ──────────────────────────────────────────────────────────────────────────────────

// A client's pack reports open under the client page's Areas tab (§1.162,
// ../ops/client/ClientAreas.tsx), which shows the switch and links here.
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
export function ImportBillPrices({ clientId }: { clientId: string }) {
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

export function EnableButton({
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

export function OpsPacksScreen() {
  const { data, error, loading, reload } = useApi(apiRoutes.opsPacks);
  const [installed, setInstalled] = useState<string[]>([]);
  const [updated, setUpdated] = useState<string | null>(null);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return null;
  return (
    <div data-testid="ops-packs">
      <PageHeader
        title="Packs"
        subtitle="Tools, skills and reports for one kind of work. Switch a pack on for a client so its agents can use them."
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
      {data.packs.map((p) => (
        <section key={p.id} className="mb-8" data-testid={`ops-pack-${p.id}`}>
          <Card className="p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-medium text-ink">{p.name}</h2>
                <p className="mt-1 max-w-2xl text-sm text-ink-muted">{p.description}</p>
              </div>
              <span className="reference text-ink-muted">v{p.version}</span>
            </div>
            <div className="mt-4 grid grid-cols-1 gap-6 md:grid-cols-2">
              <div>
                {p.templates.length > 0 ? <SectionLabel>Templates</SectionLabel> : null}
                <ul className="flex flex-col gap-1.5">
                  {p.templates.map((t) => (
                    <li key={t.slug} className="flex items-center gap-2 text-sm">
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
                          {t.newVersions === 1
                            ? "1 newer version"
                            : `${t.newVersions} newer versions`}
                        </Badge>
                      ) : null}
                    </li>
                  ))}
                </ul>
                {p.templates.some((t) => t.newVersions > 0) ? (
                  <div className="mt-2">
                    <UpdateTemplatesButton
                      pack={p.id}
                      onDone={(note) => {
                        setUpdated(note);
                        reload();
                      }}
                    />
                  </div>
                ) : null}
                <SectionLabel>Reports</SectionLabel>
                <p className="text-sm text-ink-muted">{p.screens.map((s) => s.title).join(", ")}</p>
              </div>
              <div>
                <SectionLabel>Clients</SectionLabel>
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
                        <EnableButton
                          clientId={c.id}
                          pack={p.id}
                          onDone={(slugs) => {
                            setInstalled(slugs);
                            reload();
                          }}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </Card>
        </section>
      ))}
    </div>
  );
}
