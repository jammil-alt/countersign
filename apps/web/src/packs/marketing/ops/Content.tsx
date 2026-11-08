// Content (M46, docs/plan.md §1.76): a site's guides, drafts and live ones, with their versions;
// a new guide at a fixed address; where publishing goes (the client's Website connection, pointed
// at one of its sites by the operator); and the site's redirects. Publishing happens on a guide's
// own page, signed by the person who presses it.
import { type FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useApiClient } from "../../../api/useApi";
import { Field, Select, TextInput } from "../../../ui/forms";
import {
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  SectionLabel,
  Tag,
} from "../../../ui/primitives";
import { StatusChip } from "../../../ui/status";
import { runMarketingAction, useMarketingReport } from "./api";
import { MarketingLayout, useMarketingClientId } from "./layout";
import { MARKETING_PATHS } from "./paths";

export type GuideStatus = "draft" | "published" | "unpublished";

export interface ContentRow {
  id: string;
  siteId: string;
  path: string;
  slug: string | null;
  status: GuideStatus;
  title: string;
  latestVersion: number | null;
  liveVersion: number | null;
  changedSinceLive: boolean;
  createdBy: "person" | "agent";
  createdAt: string;
  updatedAt: string;
  lastPublishedAt: string | null;
}

export interface WebsiteState {
  connected: boolean;
  domain: string | null;
  pointsHere: boolean;
}

export interface ContentReport {
  site: { id: string; domain: string; name: string } | null;
  sites: { id: string; domain: string; name: string }[];
  pages: ContentRow[];
  redirects: { from: string; to: string }[];
  website: WebsiteState;
}

/** A guide's state in words, with the chip that goes with it. */
export function guideChip(p: Pick<ContentRow, "status" | "changedSinceLive">) {
  if (p.status === "published") {
    return p.changedSinceLive ? (
      <StatusChip state="waiting">Live, changes not published</StatusChip>
    ) : (
      <StatusChip state="done">Live</StatusChip>
    );
  }
  if (p.status === "unpublished") return <StatusChip state="paused">Taken down</StatusChip>;
  return <StatusChip state="setup">Draft</StatusChip>;
}

export const dayOf = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(
        new Date(iso),
      )
    : "–";

const errorText = (e: unknown) => (e instanceof Error ? e.message : "That didn't work.");

function WebsiteCard({
  clientId,
  report,
  onChanged,
}: {
  clientId: string;
  report: ContentReport;
  onChanged: () => void;
}) {
  const api = useApiClient();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { website, site } = report;
  const point = async () => {
    if (!site) return;
    setBusy(true);
    setProblem(null);
    try {
      await runMarketingAction(api, clientId, "set-website", { site: site.id });
      onChanged();
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Where guides are published" testId="marketing-content-website" pad>
      <div className="flex flex-col gap-2">
        {!website.connected ? (
          <p className="text-ink-muted">
            This client has no Website connection yet. Offer the Website connector on the client's
            page and connect it; then point it at this site.
          </p>
        ) : website.pointsHere ? (
          <p className="text-ink">
            Guides go to <span className="font-medium">{website.domain}</span>/guides. Each publish
            is signed by the person who presses Publish.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-ink-muted">
              {website.domain
                ? `The Website connection publishes to ${website.domain}, not this site.`
                : "The Website connection isn't pointed at a site yet."}
            </p>
            <Button
              size="sm"
              variant="primary"
              disabled={busy || !site}
              onClick={point}
              data-testid="marketing-content-website-point"
            >
              Publish to {site?.domain ?? "this site"}
            </Button>
          </div>
        )}
        {problem ? (
          <p className="text-sm ui-tone-risk" role="alert">
            {problem}
          </p>
        ) : null}
      </div>
    </Card>
  );
}

function NewGuide({ clientId, siteId }: { clientId: string; siteId: string }) {
  const api = useApiClient();
  const navigate = useNavigate();
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      const r = await runMarketingAction<{ pageId: string }>(api, clientId, "create-page", {
        site: siteId,
        slug: slug.trim(),
        title: title.trim(),
      });
      navigate(MARKETING_PATHS.contentPage(clientId, r.pageId));
    } catch (err) {
      setProblem(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Card title="A new guide" testId="marketing-content-new" pad>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field
          label="Address"
          hint="Lowercase words joined by hyphens. Fixed once the guide exists: a guide that moves is a new guide and a redirect."
        >
          <div className="flex items-center gap-1">
            <span className="text-ink-muted">/guides/</span>
            <TextInput
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              placeholder="approval-workflows"
              data-testid="marketing-content-new-slug-input"
              required
            />
          </div>
        </Field>
        <Field label="Working title">
          <TextInput
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            data-testid="marketing-content-new-title-input"
          />
        </Field>
        {problem ? (
          <p className="text-sm ui-tone-risk" role="alert">
            {problem}
          </p>
        ) : null}
        <div>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || slug.trim() === ""}
            data-testid="marketing-content-new-create"
          >
            Start the guide
          </Button>
        </div>
      </form>
    </Card>
  );
}

function Redirects({
  clientId,
  report,
  onChanged,
}: {
  clientId: string;
  report: ContentReport;
  onChanged: () => void;
}) {
  const api = useApiClient();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!report.site) return null;
  const siteId = report.site.id;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      await runMarketingAction(api, clientId, "add-redirect", { site: siteId, from, to });
      setFrom("");
      setTo("");
      onChanged();
    } catch (err) {
      setProblem(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section data-testid="marketing-content-redirects">
      <SectionLabel>Redirects</SectionLabel>
      {report.redirects.length === 0 ? (
        <EmptyState testId="marketing-content-redirects-empty">
          No redirects. Add one when a guide moves or comes down for good.
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-1">
          {report.redirects.map((r) => (
            <li key={r.from} className="text-ink">
              <code>{r.from}</code> <span className="text-ink-muted">goes to</span>{" "}
              <code>{r.to}</code>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={submit} className="mt-3 flex flex-wrap items-end gap-2">
        <Field label="From" className="w-64">
          <TextInput
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            placeholder="/guides/old-name"
            data-testid="marketing-content-redirect-from-input"
          />
        </Field>
        <Field label="To" className="w-64">
          <TextInput
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="/guides/new-name"
            data-testid="marketing-content-redirect-to-input"
          />
        </Field>
        <Button
          type="submit"
          disabled={busy || !from || !to}
          data-testid="marketing-content-redirect-add"
        >
          Add the redirect
        </Button>
      </form>
      <p className="mt-1 text-sm text-ink-muted">
        A redirect reaches the site with the next publish or unpublish.
      </p>
      {problem ? (
        <p className="text-sm ui-tone-risk" role="alert">
          {problem}
        </p>
      ) : null}
    </section>
  );
}

export function MarketingContentScreen() {
  const clientId = useMarketingClientId();
  const [site, setSite] = useState("");
  const [status, setStatus] = useState<GuideStatus | "">("");
  const state = useMarketingReport<ContentReport>(clientId, "content", {
    site: site || undefined,
    status: status || undefined,
  });
  const data = state.data;
  return (
    <MarketingLayout
      title="Content"
      subtitle="The guides on your site: what is live, what is waiting, and every version."
      testId="marketing-content"
    >
      {state.loading && !data ? <Loading /> : null}
      {state.error ? <ErrorNotice error={state.error} onRetry={state.reload} /> : null}
      {data && !data.site ? (
        <EmptyState
          testId="marketing-content-no-site"
          title="No site yet"
          line="Add the client's website on the Sites page first."
          action={{ label: "Go to Sites", to: MARKETING_PATHS.sites(clientId) }}
        />
      ) : null}
      {data?.site ? (
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap items-end gap-3">
            {data.sites.length > 1 ? (
              <Field label="Site" className="w-64">
                <Select
                  value={site || data.site.id}
                  onChange={(e) => setSite(e.target.value)}
                  data-testid="marketing-content-site-select"
                >
                  {data.sites.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.domain}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <Field label="Show" className="w-48">
              <Select
                value={status}
                onChange={(e) => setStatus(e.target.value as GuideStatus | "")}
                data-testid="marketing-content-status-select"
              >
                <option value="">Every guide</option>
                <option value="draft">Drafts</option>
                <option value="published">Live</option>
                <option value="unpublished">Taken down</option>
              </Select>
            </Field>
          </div>
          <WebsiteCard clientId={clientId} report={data} onChanged={state.reload} />
          <section>
            <SectionLabel>Guides</SectionLabel>
            {data.pages.length === 0 ? (
              <EmptyState testId="marketing-content-empty">
                No guides yet. Start one below, or let the article drafts agent write one for you to
                read.
              </EmptyState>
            ) : (
              <div className="dt dt-ana">
                <div className="dt-scroll">
                  <table data-testid="marketing-content-table">
                    <thead>
                      <tr className="dt-cols">
                        <th>Guide</th>
                        <th>State</th>
                        <th className="n">Version</th>
                        <th>Changed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.pages.map((p) => (
                        <tr key={p.id} data-testid="marketing-content-row">
                          <td>
                            <Link
                              to={MARKETING_PATHS.contentPage(clientId, p.id)}
                              className="font-medium text-ink hover:underline"
                              data-testid="marketing-content-row-open"
                            >
                              {p.title || "Untitled"}
                            </Link>
                            <div className="text-sm text-ink-muted">
                              {p.path}
                              {p.createdBy === "agent" ? (
                                <>
                                  {" "}
                                  <Tag>Agent draft</Tag>
                                </>
                              ) : null}
                            </div>
                          </td>
                          <td>{guideChip(p)}</td>
                          <td className="n">
                            {p.latestVersion ?? "–"}
                            {p.liveVersion !== null && p.liveVersion !== p.latestVersion
                              ? ` (live: ${p.liveVersion})`
                              : ""}
                          </td>
                          <td>{dayOf(p.updatedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>
          <NewGuide clientId={clientId} siteId={data.site.id} />
          <Redirects clientId={clientId} report={data} onChanged={state.reload} />
        </div>
      ) : null}
    </MarketingLayout>
  );
}
