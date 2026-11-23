// SOC 2 readiness (`/ops/security/soc2`, docs/plan.md §1.218): every criterion in our scope as in
// place, partial or missing, with its owner, what answers it and where the evidence is; the
// quarterly access review's record (record this quarter's, download any as CSV); and the last
// deletion drill. Loaded lazily (routes.tsx), with its schemas (`soc2Routes`), so none of it is in
// the app's first load.
//
// DECISION (§1.218): the checklist is computed here from core's register (`soc2Readiness`) and the
// few facts only the database knows (GET /api/ops/security/soc2), as the other Security tabs read
// the register: a control's status changes by pull request, not by a click.
import {
  type AccessReviewFact,
  type AccessReviewUser,
  type AccessReviewView,
  type DeletionDrillFact,
  quarterOf,
  READINESS_STATUS_NAMES,
  type ReadinessStatus,
  readinessCounts,
  routes,
  SOC2_CATEGORIES,
  SOC2_CATEGORY_NAMES,
  type Soc2Row,
  soc2Readiness,
  soc2Routes,
} from "@countersign/core";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useApi, useApiClient } from "../../api/useApi";
import { EN } from "../../i18n/i18n";
import { KpiStrip, StatTile } from "../../ui/figures";
import { Loaded } from "../../ui/page";
import { Badge, Button, Card, EmptyState, ErrorNotice, Tag, type Tone } from "../../ui/primitives";
import { auditTime, download, ROLE_NAMES } from "../screens/AuditLog";
import { TableCard } from "../screens/business";
import { SECURITY_PATHS } from "./paths";
import { SecurityPage } from "./SecurityScreens";

const TONE: Record<ReadinessStatus, Tone> = {
  in_place: "positive",
  partial: "warning",
  missing: "risk",
};

function ReadinessBadge({ status }: { status: ReadinessStatus }) {
  return (
    <Badge tone={TONE[status]} testId="soc2-status">
      {READINESS_STATUS_NAMES[status]}
    </Badge>
  );
}

const day = (iso: string) => EN.fmt.date(iso);
const roleName = (role: string) => ROLE_NAMES[role] ?? role;

export default function Soc2ReadinessScreen() {
  const facts = useApi(soc2Routes.opsSoc2Facts, {});
  return (
    <SecurityPage
      testId="ops-security-soc2"
      title="SOC 2 readiness"
      subtitle="Each criterion in our scope (Security, Availability, Confidentiality): what answers it, who owns it and where the evidence is. The mapping is ours; the auditor confirms it."
    >
      <Loaded state={facts}>
        {(data) => (
          <div className="flex flex-col gap-8">
            <Checklist rows={soc2Readiness(data)} />
            <AccessReviews reviews={data.accessReviews} now={data.now} onRecorded={facts.reload} />
            <DeletionDrill drill={data.deletionDrill} />
          </div>
        )}
      </Loaded>
    </SecurityPage>
  );
}

// ── The checklist ────────────────────────────────────────────────────────────────────────────────

function Checklist({ rows }: { rows: Soc2Row[] }) {
  const counts = readinessCounts(rows);
  return (
    <>
      <KpiStrip testId="soc2-counts">
        {/* QA SC1: criteria, not controls (the Overview counts controls). */}
        <StatTile label="Criteria in our scope" value={rows.length} />
        <StatTile label="Criteria in place" value={counts.in_place} />
        <StatTile label="Criteria partly in place" value={counts.partial} />
        <StatTile label="Criteria missing" value={counts.missing} />
      </KpiStrip>
      {SOC2_CATEGORIES.map((category) => {
        const own = rows.filter((r) => r.category === category);
        const c = readinessCounts(own);
        return (
          <TableCard
            key={category}
            title={`${category} · ${SOC2_CATEGORY_NAMES[category]}`}
            meta={`${c.in_place} of ${own.length} criteria in place · Owner: ${own[0]?.owner ?? ""}`}
            testId={`soc2-${category}`}
          >
            <table>
              <thead>
                <tr>
                  <th>Criterion</th>
                  <th>Status</th>
                  <th>What answers it</th>
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {own.map((r) => (
                  <CriterionRow key={r.id} row={r} />
                ))}
              </tbody>
            </table>
          </TableCard>
        );
      })}
    </>
  );
}

function CriterionRow({ row }: { row: Soc2Row }) {
  const nothing = row.controls.length === 0 && row.checks.length === 0;
  return (
    <tr data-testid={`soc2-row-${row.id}`} className="align-top">
      <td className="text-ink">
        <span className="font-mono text-ink-muted">{row.id}</span> {row.title}
      </td>
      <td>
        <ReadinessBadge status={row.status} />
      </td>
      <td>
        {nothing ? (
          <span className="text-ink-muted">Nothing yet. {row.hint}</span>
        ) : (
          <ul className="flex flex-col gap-1">
            {row.controls.map((c) => (
              <li key={c.id}>
                <Link to={`${SECURITY_PATHS.controls}#${c.id}`} className="hover:underline">
                  <span className="font-mono text-ink-muted">{c.id}</span> {c.title}
                </Link>
                {c.status !== "in_place" && c.gap ? (
                  <span className="block text-xs text-ink-muted">{c.gap}</span>
                ) : null}
              </li>
            ))}
            {row.checks.map((c) => (
              <li key={c.id} data-testid={`soc2-check-${c.id}`}>
                {c.title}
                <span className="block text-xs text-ink-muted">{c.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </td>
      <td>
        <ul className="flex flex-col gap-1">
          {row.evidence.map((e) => (
            <li key={`${e.kind}:${e.ref}`} className="text-xs">
              <Tag>{e.kind}</Tag>{" "}
              {e.ref.startsWith("/ops") ? (
                <Link to={e.ref} className="text-slate hover:underline">
                  {e.ref.replace(/^\/ops\/security\/?/, "Security ").trim() || "Security"}
                </Link>
              ) : (
                <span className="font-mono">{e.ref}</span>
              )}
            </li>
          ))}
        </ul>
      </td>
    </tr>
  );
}

// ── Access reviews ───────────────────────────────────────────────────────────────────────────────

const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** A recorded review as CSV: one line per person and client, with the decision. */
export function recordedReviewCsv(review: AccessReviewView): string {
  const out = [
    [
      "Quarter",
      "Recorded",
      "Reviewer",
      "Email",
      "Name",
      "Client",
      "Role",
      "Last sign-in",
      "Last seen",
      "Decision",
      "Note",
    ],
  ];
  for (const i of review.items) {
    out.push([
      review.period,
      review.createdAt,
      review.reviewerEmail,
      i.email,
      i.name ?? "",
      i.client.name ?? i.client.id,
      roleName(i.role),
      i.lastSignInAt ?? "",
      i.lastSeenAt ?? "",
      i.decision === "remove" ? "Remove" : "Keep",
      i.note,
    ]);
  }
  return `${out.map((l) => l.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

function AccessReviews({
  reviews,
  now,
  onRecorded,
}: {
  reviews: readonly AccessReviewFact[];
  now: string;
  onRecorded: () => void;
}) {
  const api = useApiClient();
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const quarter = quarterOf(new Date(now));
  const csv = async (id: string) => {
    setError(null);
    try {
      const review = await api.call(soc2Routes.opsAccessReviewRecord, { params: { id } });
      download(
        `access-review-${review.period}-${review.createdAt.slice(0, 10)}.csv`,
        recordedReviewCsv(review),
      );
    } catch (e) {
      setError(e);
    }
  };
  return (
    <section id="access-reviews" className="flex flex-col gap-4" data-testid="soc2-access-reviews">
      <TableCard
        title="Quarterly access reviews"
        meta={
          recording ? null : (
            <Button
              size="sm"
              variant="primary"
              onClick={() => setRecording(true)}
              data-testid="soc2-record"
            >
              Record {quarter}'s review
            </Button>
          )
        }
      >
        {reviews.length === 0 ? (
          <EmptyState>
            No reviews recorded yet. {quarter}'s is due by the end of the quarter.
          </EmptyState>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Quarter</th>
                <th>Recorded</th>
                <th>By</th>
                <th>People</th>
                <th>To remove</th>
                <th>
                  <span className="sr-only">Download</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {reviews.map((r) => (
                <tr key={r.id} data-testid={`soc2-review-${r.id}`}>
                  <td className="text-ink">{r.period}</td>
                  <td>{day(r.createdAt)}</td>
                  <td>{r.reviewerEmail}</td>
                  <td className="figures">{r.people}</td>
                  <td className="figures">{r.removals}</td>
                  <td>
                    <Button size="sm" onClick={() => void csv(r.id)}>
                      Download CSV
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableCard>
      {error ? <ErrorNotice error={error} /> : null}
      {recording ? (
        <RecordReview
          quarter={quarter}
          onCancel={() => setRecording(false)}
          onDone={() => {
            setRecording(false);
            onRecorded();
          }}
        />
      ) : null}
    </section>
  );
}

function RecordReview({
  quarter,
  onCancel,
  onDone,
}: {
  quarter: string;
  onCancel: () => void;
  onDone: () => void;
}) {
  const api = useApiClient();
  const people = useApi(routes.opsAccessReview, {});
  const [remove, setRemove] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.call(soc2Routes.opsAccessReviewCreate, {
        body: {
          note,
          remove: Object.entries(remove).map(([key, n]) => {
            const [clientId = "", userId = ""] = key.split(":");
            return { clientId, userId, note: n };
          }),
        },
      });
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card title={`Record ${quarter}'s access review`} testId="soc2-record-form">
      <p className="mb-4 text-ink-muted">
        Read each person's access and tick anyone who should lose it. Everyone else is kept. Remove
        their access where you always do (the client's People page, or the remove-operator
        workflow); the next review shows it went. Review each provider console too, and say so in
        the note.
      </p>
      <Loaded state={people}>
        {(data) => <ReviewTable users={data.users} remove={remove} setRemove={setRemove} />}
      </Loaded>
      <label className="mt-4 block text-sm">
        Note
        <textarea
          className="ds-textarea mt-1 w-full"
          rows={3}
          maxLength={2000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Consoles reviewed, anything found"
          data-testid="soc2-record-note"
        />
      </label>
      {error ? <ErrorNotice error={error} /> : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          variant="primary"
          working={saving}
          onClick={() => void save()}
          data-testid="soc2-record-save"
        >
          Record the review
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </Card>
  );
}

function ReviewTable({
  users,
  remove,
  setRemove,
}: {
  users: AccessReviewUser[];
  remove: Record<string, string>;
  setRemove: (next: Record<string, string>) => void;
}) {
  const lines = useMemo(
    () =>
      users.flatMap((u) =>
        u.memberships.map((m) => ({ key: `${m.client.id}:${u.id}`, user: u, membership: m })),
      ),
    [users],
  );
  if (lines.length === 0) return <EmptyState>No one has access to your clients.</EmptyState>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" data-testid="soc2-record-table">
        <thead>
          <tr>
            <th className="text-left">Person</th>
            <th className="text-left">Client and role</th>
            <th className="text-left">Last sign-in</th>
            <th className="text-left">Remove</th>
          </tr>
        </thead>
        <tbody>
          {lines.map(({ key, user, membership }) => {
            const ticked = key in remove;
            return (
              <tr key={key} className="align-top">
                <td className="text-ink">
                  {user.name ?? user.email}
                  {user.name ? (
                    <span className="block text-xs text-ink-muted">{user.email}</span>
                  ) : null}
                </td>
                <td>
                  {membership.client.name} · {roleName(membership.role)}
                  {membership.client.retired ? (
                    <span className="block text-xs text-ink-muted">Retired client</span>
                  ) : null}
                </td>
                <td>{user.lastSignInAt ? auditTime(user.lastSignInAt) : "Never"}</td>
                <td>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={ticked}
                      onChange={(e) => {
                        const next = { ...remove };
                        if (e.target.checked) next[key] = "";
                        else delete next[key];
                        setRemove(next);
                      }}
                      data-testid={`soc2-remove-${key}`}
                    />
                    <span className="sr-only">
                      Remove {user.email} from {membership.client.name}
                    </span>
                  </label>
                  {ticked ? (
                    <input
                      className="ds-input mt-1 h-8 text-sm"
                      maxLength={500}
                      placeholder="Why"
                      value={remove[key] ?? ""}
                      onChange={(e) => setRemove({ ...remove, [key]: e.target.value })}
                    />
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── The deletion drill ───────────────────────────────────────────────────────────────────────────

function DeletionDrill({ drill }: { drill: DeletionDrillFact | null }) {
  return (
    <Card title="Deletion drill" testId="soc2-deletion-drill">
      {drill ? (
        <p>
          {drill.ok ? <Badge tone="positive">Passed</Badge> : <Badge tone="risk">Failed</Badge>}{" "}
          {drill.ok
            ? `${day(drill.at)}: a Sandbox client's ${drill.rows} rows in ${drill.tables} tables were purged, and nothing of it was left.`
            : `${day(drill.at)}: ${drill.failed ?? "see the audit log"}.`}
        </p>
      ) : (
        <p>Not run yet.</p>
      )}
      <p className="mt-2 text-ink-muted">
        Once a year, on staging:{" "}
        <span className="font-mono text-xs">
          pnpm --filter @countersign/db run db:deletion-drill
        </span>{" "}
        as cs_owner. It fills a throwaway Sandbox client, retires and purges it the way a leaving
        client is purged, checks nothing is left, and writes the result to the audit log.
      </p>
    </Card>
  );
}
