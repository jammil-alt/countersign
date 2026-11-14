// Security and compliance (`/ops/security/*`, docs/plan.md §1.100): one place for everything that
// protects clients' data, from our own controls to each client's standing, so the owner can show an
// auditor or a client's IT team where things are, and work through SOC 2, HIPAA and PCI.
//
// Tabs: Overview (each framework's progress, what's open, the routines), Controls (the register in
// packages/core, filterable by framework, area and status), Vendors (who receives client data, and
// which have a signed BAA), Policies (the written policies and the routines that keep the controls
// working), Clients (each client's tier and access, with a summary page for its IT team) and the
// Audit log (moved here from Utilities).
//
// DECISION (§1.100): the register is code (`CONTROLS`), so these pages read it from
// `@countersign/core`; only what changes with the data (clients, BAAs, the audit log) comes from
// GET /api/ops/security.
import {
  CONTROL_AREA_NAMES,
  CONTROL_AREAS,
  CONTROL_STATUS_NAMES,
  CONTROLS,
  type Control,
  type ControlArea,
  type ControlStatus,
  controlsForTier,
  EVIDENCE_KIND_NAMES,
  FRAMEWORK_NAMES,
  FRAMEWORK_SCOPE,
  FRAMEWORKS,
  type Framework,
  frameworkSummaries,
  OUT_OF_SCOPE_VENDORS,
  POLICIES,
  PROCESSOR_NAMES,
  PROCESSOR_RECEIVES,
  ROUTINE_CADENCE_NAMES,
  ROUTINES,
  type SecurityClientRow,
  type SecurityOverview,
  VENDOR_ORDER,
} from "@countersign/core";
import type { ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { StatusFilter } from "../../inbox/StatusFilter";
import { KpiStrip, StatTile } from "../../ui/figures";
import { Columns, Loaded, Page } from "../../ui/page";
import { Badge, Button, Card, EmptyState, PageHeader, Tag, type Tone } from "../../ui/primitives";
import { TableCard } from "../screens/business";
import { SECURITY_PATHS } from "./paths";
import { SecurityTabs } from "./SecurityTabs";

const STATUS_TONE: Record<ControlStatus, Tone> = {
  in_place: "positive",
  partial: "warning",
  planned: "neutral",
};

export function StatusBadge({ status }: { status: ControlStatus }) {
  return (
    <Badge tone={STATUS_TONE[status]} testId="security-status">
      {CONTROL_STATUS_NAMES[status]}
    </Badge>
  );
}

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const pct = (n: number, of: number) => (of === 0 ? 0 : Math.round((n / of) * 100));

function SecurityPage({
  testId,
  title,
  subtitle,
  actions,
  children,
}: {
  testId: string;
  title: string;
  subtitle: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Page testId={testId}>
      <PageHeader
        eyebrow="Security and compliance"
        title={title}
        subtitle={subtitle}
        actions={actions}
      />
      <SecurityTabs />
      {children}
    </Page>
  );
}

// ── Overview ─────────────────────────────────────────────────────────────────────────────────────

export function SecurityOverviewScreen() {
  const state = useApi(apiRoutes.opsSecurity, {});
  const summaries = frameworkSummaries();
  const open = CONTROLS.filter((c) => c.status !== "in_place");
  const inPlace = CONTROLS.filter((c) => c.status === "in_place").length;
  return (
    <SecurityPage
      testId="ops-security"
      title="Overview"
      subtitle={`${inPlace} of ${CONTROLS.length} controls in place. Framework references are our own mapping; the auditor confirms them.`}
    >
      <div className="flex flex-col gap-8">
        <Columns count={3}>
          {summaries.map((s) => (
            <FrameworkCard key={s.framework} summary={s} />
          ))}
        </Columns>

        <Loaded state={state}>{(data) => <OverviewFigures data={data} />}</Loaded>

        <TableCard title="Still open" meta={`${open.length} controls`} testId="ops-security-open">
          <table>
            <thead>
              <tr>
                <th>Control</th>
                <th>What's open</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {open.map((c) => (
                <tr key={c.id} data-testid={`ops-security-open-${c.id}`}>
                  <td className="text-ink">
                    <Link to={`${SECURITY_PATHS.controls}#${c.id}`} className="hover:underline">
                      <span className="font-mono text-ink-muted">{c.id}</span> {c.title}
                    </Link>
                  </td>
                  <td>{c.gap}</td>
                  <td>
                    <StatusBadge status={c.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableCard>
      </div>
    </SecurityPage>
  );
}

function FrameworkCard({ summary }: { summary: ReturnType<typeof frameworkSummaries>[number] }) {
  const { framework, controls, counts, references } = summary;
  const done = pct(counts.in_place, controls);
  return (
    <Card pad testId={`ops-security-framework-${framework}`}>
      <p className="eyebrow text-ink-muted">{FRAMEWORK_NAMES[framework]}</p>
      <p className="type-title mt-1 text-ink figures">{done}%</p>
      <p className="text-sm text-ink-muted">
        {counts.in_place} of {controls} controls in place, {references} references
      </p>
      <div
        className="mt-3 flex h-1.5 overflow-hidden rounded-full bg-line"
        role="img"
        aria-label={`${counts.in_place} in place, ${counts.partial} partly, ${counts.planned} planned`}
      >
        <span className="bg-positive" style={{ width: `${pct(counts.in_place, controls)}%` }} />
        <span className="bg-signal" style={{ width: `${pct(counts.partial, controls)}%` }} />
      </div>
      <p className="mt-3 text-sm text-ink-muted">{FRAMEWORK_SCOPE[framework]}</p>
      <Link
        to={`${SECURITY_PATHS.controls}?framework=${framework}`}
        className="mt-3 inline-block text-sm text-slate hover:underline"
      >
        See its controls
      </Link>
    </Card>
  );
}

function OverviewFigures({ data }: { data: SecurityOverview }) {
  const active = data.clients.filter((c) => !c.retiredAt);
  const regulated = active.filter((c) => c.tier === "regulated").length;
  return (
    <KpiStrip testId="ops-security-figures">
      <StatTile
        label="Clients"
        value={active.length}
        note={`${regulated} regulated, ${active.length - regulated} standard`}
        to={SECURITY_PATHS.clients}
      />
      <StatTile
        label="Vendors with a BAA"
        value={`${data.covered.length} of ${VENDOR_ORDER.length}`}
        {...(data.covered.length === 0
          ? { note: "No client can be regulated yet", noteTone: "signal" as const }
          : {})}
        to={SECURITY_PATHS.vendors}
      />
      <StatTile
        label="Audit log, 30 days"
        value={data.audit30d.events.toLocaleString()}
        note={`${data.audit30d.refused.toLocaleString()} refused`}
        to={SECURITY_PATHS.audit}
      />
      <StatTile
        label="Routines"
        value={ROUTINES.length}
        note="Recorded outside the product for now"
        to={SECURITY_PATHS.policies}
      />
    </KpiStrip>
  );
}

// ── Controls ─────────────────────────────────────────────────────────────────────────────────────

const FRAMEWORK_OPTIONS: [string, string][] = [
  ["all", "All"],
  ...FRAMEWORKS.map((f): [string, string] => [f, FRAMEWORK_NAMES[f]]),
];
const STATUS_OPTIONS: [string, string][] = [
  ["all", "Any status"],
  ["in_place", "In place"],
  ["partial", "Partly"],
  ["planned", "Planned"],
];

export function SecurityControlsScreen() {
  const [params, setParams] = useSearchParams();
  const framework = FRAMEWORKS.find((f) => f === params.get("framework")) ?? null;
  const status = (["in_place", "partial", "planned"] as const).find(
    (s) => s === params.get("status"),
  );
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value === "all") next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };
  const shown = CONTROLS.filter(
    (c) => (!framework || (c.maps[framework]?.length ?? 0) > 0) && (!status || c.status === status),
  );
  return (
    <SecurityPage
      testId="ops-security-controls"
      title="Controls"
      subtitle="What we do to protect clients' data, where the evidence is, and what each answers."
      actions={
        <>
          <StatusFilter
            value={framework ?? "all"}
            onChange={(v) => set("framework", v)}
            area="ops-security-framework"
            label="Framework"
            options={FRAMEWORK_OPTIONS}
          />
          <StatusFilter
            value={status ?? "all"}
            onChange={(v) => set("status", v)}
            area="ops-security-status"
            label="Status"
            options={STATUS_OPTIONS}
          />
        </>
      }
    >
      {shown.length === 0 ? (
        <EmptyState title="No controls match" line="Try another framework or status." />
      ) : (
        <div className="flex flex-col gap-8">
          {CONTROL_AREAS.map((area) => {
            const rows = shown.filter((c) => c.area === area);
            return rows.length ? (
              <ControlAreaCard key={area} area={area} controls={rows} framework={framework} />
            ) : null;
          })}
        </div>
      )}
    </SecurityPage>
  );
}

function ControlAreaCard({
  area,
  controls,
  framework,
}: {
  area: ControlArea;
  controls: Control[];
  framework: Framework | null;
}) {
  return (
    <Card titleAbove title={CONTROL_AREA_NAMES[area]} testId={`ops-security-area-${area}`}>
      <ul className="divide-y divide-line">
        {controls.map((c) => (
          <ControlRow key={c.id} control={c} framework={framework} />
        ))}
      </ul>
    </Card>
  );
}

export function ControlRow({
  control: c,
  framework,
  showEvidence = true,
}: {
  control: Control;
  framework: Framework | null;
  showEvidence?: boolean;
}) {
  const maps = FRAMEWORKS.filter((f) => !framework || f === framework).flatMap((f) =>
    (c.maps[f] ?? []).length ? [[f, c.maps[f] ?? []] as const] : [],
  );
  return (
    <li id={c.id} className="flex flex-col gap-2 px-6 py-4" data-testid={`ops-control-${c.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm text-ink-muted">{c.id}</span>
        <span className="font-medium text-ink">{c.title}</span>
        <StatusBadge status={c.status} />
        {c.tier === "regulated" ? <Tag>Regulated clients</Tag> : null}
      </div>
      <p className="text-ink">{c.statement}</p>
      {c.gap ? <p className="text-sm text-ink-muted">Open: {c.gap}</p> : null}
      {maps.length ? (
        <p className="text-sm text-ink-muted" data-testid="ops-control-maps">
          {maps.map(([f, refs], i) => (
            <span key={f}>
              {i > 0 ? " · " : ""}
              <span className="text-ink">{FRAMEWORK_NAMES[f]}</span> {refs.join(", ")}
            </span>
          ))}
        </p>
      ) : null}
      {showEvidence ? (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm" data-testid="ops-control-evidence">
          {c.evidence.map((e) => (
            <li key={`${e.kind}:${e.ref}`} className="text-ink-muted">
              {EVIDENCE_KIND_NAMES[e.kind]}:{" "}
              {e.ref.startsWith("/ops") ? (
                <Link to={e.ref} className="text-slate hover:underline">
                  {e.ref}
                </Link>
              ) : (
                <span className="font-mono text-ink">{e.ref}</span>
              )}
              {e.note ? ` (${e.note})` : null}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

// ── Vendors ──────────────────────────────────────────────────────────────────────────────────────

export function SecurityVendorsScreen() {
  const state = useApi(apiRoutes.opsSecurity, {});
  return (
    <SecurityPage
      testId="ops-security-vendors"
      title="Vendors"
      subtitle="Every vendor of ours that receives client data. A regulated client's data goes only to vendors with a signed BAA."
    >
      <div className="flex flex-col gap-8">
        <Loaded state={state}>
          {(data) => {
            const covered = new Set(data.covered);
            return (
              <TableCard
                title="Vendors that receive client data"
                meta={`${covered.size} of ${VENDOR_ORDER.length} with a BAA`}
                testId="ops-security-vendor-table"
              >
                <table>
                  <thead>
                    <tr>
                      <th>Vendor</th>
                      <th>What it receives</th>
                      <th>BAA</th>
                    </tr>
                  </thead>
                  <tbody>
                    {VENDOR_ORDER.map((p) => (
                      <tr key={p} data-testid={`ops-security-vendor-${p}`}>
                        <td className="text-ink">{PROCESSOR_NAMES[p]}</td>
                        <td>{PROCESSOR_RECEIVES[p]}</td>
                        <td>
                          {covered.has(p) ? (
                            <Badge tone="positive">Signed</Badge>
                          ) : (
                            <Badge>Not signed</Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableCard>
            );
          }}
        </Loaded>
        <TableCard title="Kept out of scope" testId="ops-security-out-of-scope">
          <table>
            <thead>
              <tr>
                <th>Vendor</th>
                <th>How</th>
              </tr>
            </thead>
            <tbody>
              {OUT_OF_SCOPE_VENDORS.map((v) => (
                <tr key={v.name}>
                  <td className="text-ink">{v.name}</td>
                  <td>{v.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableCard>
        <p className="text-sm text-ink-muted">
          A client's own tools (QuickBooks, Gmail, Google Drive and the rest) are the client's
          vendors, not ours: the client signs in to them, and we only act within what it allows.
        </p>
      </div>
    </SecurityPage>
  );
}

// ── Policies and routines ────────────────────────────────────────────────────────────────────────

export function SecurityPoliciesScreen() {
  return (
    <SecurityPage
      testId="ops-security-policies"
      title="Policies and routines"
      subtitle="What we commit to in writing, and the recurring work that shows the controls keep working."
    >
      <div className="flex flex-col gap-8">
        <TableCard title="Policies" testId="ops-security-policy-table">
          <table>
            <thead>
              <tr>
                <th>Policy</th>
                <th>Version</th>
                <th>Adopted</th>
                <th>Next review</th>
              </tr>
            </thead>
            <tbody>
              {POLICIES.map((p) => (
                <tr key={p.id} data-testid={`ops-security-policy-${p.id}`}>
                  <td className="text-ink">
                    {p.title}
                    {p.path ? (
                      <span className="block font-mono text-xs text-ink-muted">{p.path}</span>
                    ) : null}
                  </td>
                  {p.version ? (
                    <>
                      <td className="figures">{p.version}</td>
                      <td>{p.adopted ? day(p.adopted) : null}</td>
                      <td>{p.nextReview ? day(p.nextReview) : null}</td>
                    </>
                  ) : (
                    <td colSpan={3}>
                      <Badge>To write</Badge>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </TableCard>
        <TableCard
          title="Routines"
          meta="SOC 2 Type II's evidence: each done on time, and recorded"
          testId="ops-security-routine-table"
        >
          <table>
            <thead>
              <tr>
                <th>Routine</th>
                <th>How often</th>
                <th>What to do and keep</th>
                <th>Where</th>
              </tr>
            </thead>
            <tbody>
              {ROUTINES.map((r) => (
                <tr key={r.id} data-testid={`ops-security-routine-${r.id}`}>
                  <td className="text-ink">{r.title}</td>
                  <td>{ROUTINE_CADENCE_NAMES[r.cadence]}</td>
                  <td>{r.how}</td>
                  <td>
                    {r.where.startsWith("/ops") ? (
                      <Link to={r.where} className="text-slate hover:underline">
                        Open
                      </Link>
                    ) : (
                      <span className="font-mono text-xs">{r.where}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableCard>
      </div>
    </SecurityPage>
  );
}

// ── Clients ──────────────────────────────────────────────────────────────────────────────────────

const TIER_NAMES: Record<SecurityClientRow["tier"], string> = {
  standard: "Standard",
  regulated: "Regulated",
};

export function SecurityClientsScreen() {
  const state = useApi(apiRoutes.opsSecurity, {});
  return (
    <SecurityPage
      testId="ops-security-clients"
      title="Clients"
      subtitle="Each client's tier and who can reach its data. Open one for the summary to give its IT team."
    >
      <Loaded state={state}>
        {(data) =>
          data.clients.length === 0 ? (
            <EmptyState title="No clients yet" />
          ) : (
            <TableCard title="Clients" meta={`${data.clients.length}`}>
              <table>
                <thead>
                  <tr>
                    <th>Client</th>
                    <th>Tier</th>
                    <th className="n">Admins</th>
                    <th className="n">Users</th>
                    <th>Last sign-in</th>
                    <th>State</th>
                  </tr>
                </thead>
                <tbody>
                  {data.clients.map((c) => (
                    <tr key={c.id} data-testid={`ops-security-client-${c.id}`}>
                      <td className="text-ink">
                        <Link to={SECURITY_PATHS.client(c.id)} className="hover:underline">
                          {c.name}
                        </Link>
                        {c.sandbox ? <Tag className="ml-2">Sandbox</Tag> : null}
                      </td>
                      <td>
                        {c.tier === "regulated" ? (
                          <Badge tone="accent">Regulated</Badge>
                        ) : (
                          <Badge>Standard</Badge>
                        )}
                      </td>
                      <td className="n">{c.admins}</td>
                      <td className="n">{c.users}</td>
                      <td>{c.lastSignInAt ? day(c.lastSignInAt) : "Never"}</td>
                      <td>
                        {c.retiredAt ? (
                          <Badge>
                            Retired{c.purgeAfter ? `, purged after ${day(c.purgeAfter)}` : ""}
                          </Badge>
                        ) : (
                          <Badge tone="positive">Active</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableCard>
          )
        }
      </Loaded>
    </SecurityPage>
  );
}

/**
 * One client's security summary, for its IT team or an auditor: its tier, how its data is kept
 * apart and protected, where it goes, and the controls it gets. Prints cleanly (the frame and the
 * tabs hide on paper).
 */
export function SecurityClientScreen() {
  const { clientId = "" } = useParams();
  const state = useApi(apiRoutes.opsSecurity, {});
  return (
    <Page testId="ops-security-client">
      <Loaded state={state}>
        {(data) => {
          const client = data.clients.find((c) => c.id === clientId);
          if (!client) {
            return (
              <EmptyState
                title="Client not found"
                action={{ to: SECURITY_PATHS.clients, label: "All clients" }}
              />
            );
          }
          return <ClientSummary client={client} data={data} />;
        }}
      </Loaded>
    </Page>
  );
}

function ClientSummary({ client, data }: { client: SecurityClientRow; data: SecurityOverview }) {
  const regulated = client.tier === "regulated";
  const controls = controlsForTier(regulated);
  const inPlace = controls.filter((c) => c.status === "in_place");
  const covered = new Set(data.covered);
  return (
    <>
      <PageHeader
        eyebrow="Security summary"
        title={client.name}
        subtitle={`Prepared by Mezonas on ${day(data.generatedAt)}. ${TIER_NAMES[client.tier]} tier.`}
        actions={
          <span className="flex gap-2" data-print="hide">
            <Link to={SECURITY_PATHS.clients} className="ds-btn ds-btn--ghost">
              All clients
            </Link>
            <Link
              to={`/ops/clients/${client.id}/settings/compliance`}
              className="ds-btn ds-btn--secondary"
            >
              Compliance settings
            </Link>
            <Button variant="primary" onClick={() => window.print()} data-testid="security-print">
              Print or save as PDF
            </Button>
          </span>
        }
      />
      <div className="flex flex-col gap-8">
        <KpiStrip testId="ops-security-client-figures">
          <StatTile label="Tier" value={TIER_NAMES[client.tier]} />
          <StatTile label="Controls in place" value={`${inPlace.length} of ${controls.length}`} />
          <StatTile
            label="People with access"
            value={client.admins + client.users}
            note={`${plural(client.admins, "admin")}, ${plural(client.users, "user")}`}
          />
          <StatTile
            label="Last sign-in"
            value={client.lastSignInAt ? day(client.lastSignInAt) : "Never"}
          />
        </KpiStrip>

        <Card pad title="How your data is protected">
          <ul className="flex list-disc flex-col gap-2 pl-5 text-ink">
            <li>
              Your data is walled off from every other client's in the database, by row-level
              security our application cannot bypass.
            </li>
            <li>
              Encrypted in transit (TLS 1.2 or higher) and at rest (AES-256). Your connection tokens
              and logins are encrypted with your own key and never shown to anyone, us included.
            </li>
            <li>
              Every sign-in needs a second factor. Sessions end after 30 minutes idle and 12 hours
              in total.
            </li>
            <li>
              Agents change your tools only with a person's approval by default, each change once,
              with the record's state before it kept.
            </li>
            <li>Every read and change is in an audit log that can't be edited, kept 6 years.</li>
            <li>No model provider trains on your data. Card numbers are never stored.</li>
            {regulated ? (
              <li>
                In HIPAA mode: your data goes only to vendors with a signed business associate
                agreement; the product refuses the rest.
              </li>
            ) : null}
          </ul>
        </Card>

        <TableCard
          title="Where your data goes"
          meta={
            regulated
              ? "Only vendors with a signed BAA"
              : "Depending on the features and models you use"
          }
          testId="ops-security-client-vendors"
        >
          <table>
            <thead>
              <tr>
                <th>Vendor</th>
                <th>What it receives</th>
                {regulated ? <th>BAA</th> : null}
              </tr>
            </thead>
            <tbody>
              {VENDOR_ORDER.filter((p) => !regulated || covered.has(p)).map((p) => (
                <tr key={p}>
                  <td className="text-ink">{PROCESSOR_NAMES[p]}</td>
                  <td>{PROCESSOR_RECEIVES[p]}</td>
                  {regulated ? (
                    <td>
                      <Badge tone="positive">Signed</Badge>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </TableCard>

        <Card titleAbove title="Controls" meta={`${controls.length}`}>
          <ul className="divide-y divide-line">
            {controls.map((c) => (
              <ControlRow key={c.id} control={c} framework={null} showEvidence={false} />
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
