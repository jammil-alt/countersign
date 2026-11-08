// Sites (M44, docs/marketing-plan.md §4.3, §4.7): a client's measured websites. Add one, change its
// name and goals (the tracked elements whose click counts as reaching a goal), switch it off or on,
// and copy the snippet its owner pastes into every page. For the Sandbox, fill the last 28 days
// with sample traffic so the screens have figures. All of it is a person's action, never an
// agent's.
import { useState } from "react";
import { isApiError } from "../../../api/client";
import { useApiClient } from "../../../api/useApi";
import { useClientSummary } from "../../../ops/OpsLayout";
import { Field, TextInput } from "../../../ui/forms";
import { Loaded, Section } from "../../../ui/page";
import { Badge, Button, Card, EmptyState, Tag } from "../../../ui/primitives";
import { runMarketingAction, useMarketingReport } from "./api";
import {
  countWords,
  dayWords,
  MarketingLayout,
  type MarketingSite,
  useMarketingClientId,
} from "./layout";
import { siteSnippet } from "./SitesSnippet";

export interface SiteStatusRow extends MarketingSite {
  lastEventDay: string | null;
  dataThrough: string | null;
  visitsLast7: number;
}

export interface SitesReport {
  sites: SiteStatusRow[];
  /** M50: the client is in HIPAA mode, so nothing its sites send is stored. */
  measurementHeld?: boolean;
}

/** "hero-talk, contact-email" or "hero-talk contact-email" → the names. */
export function parseGoals(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((g) => g.trim())
        .filter(Boolean),
    ),
  ];
}

const GOAL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

function failure(error: unknown): string {
  if (isApiError(error)) {
    if (error.code === "refused" && error.message) return error.message;
    if (error.code === "invalid_body")
      return "Check the fields: a goal is lower case letters, digits and hyphens.";
  }
  return "We couldn't save that. Try again.";
}

function CopySnippet({ value, testId }: { value: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      data-testid={testId}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          },
          () => {},
        );
      }}
    >
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

export function MarketingSitesScreen() {
  const clientId = useMarketingClientId();
  const client = useClientSummary(clientId);
  const state = useMarketingReport<SitesReport>(clientId, "sites");
  return (
    <MarketingLayout
      title="Sites"
      subtitle="The client's measured websites, their goals and the snippet that measures them."
      testId="marketing-sites"
    >
      <Loaded state={state}>
        {(r) => (
          <div className="flex flex-col gap-6">
            {r.measurementHeld ? (
              <Card pad testId="marketing-sites-held">
                <p className="font-medium text-ink">Measurement is held</p>
                <p className="mt-1 text-sm text-ink-muted">
                  This client is in HIPAA mode, so nothing its sites send is stored. Its snippet
                  does no harm on a page, but no visits are counted until the owner decides how to
                  measure a health client's site.
                </p>
              </Card>
            ) : null}
            {r.sites.length === 0 ? (
              <EmptyState
                testId="marketing-sites-empty"
                title="No site measured yet"
                line="Add the client's website below, then paste its snippet into every page."
              />
            ) : (
              r.sites.map((s) => (
                <SiteCard key={s.id} clientId={clientId} site={s} onSaved={state.reload} />
              ))
            )}
            <AddSite clientId={clientId} onAdded={state.reload} />
            {client?.sandbox ? <SampleTraffic clientId={clientId} onFilled={state.reload} /> : null}
          </div>
        )}
      </Loaded>
    </MarketingLayout>
  );
}

function SiteCard({
  clientId,
  site,
  onSaved,
}: {
  clientId: string;
  site: SiteStatusRow;
  onSaved: () => void;
}) {
  const api = useApiClient();
  const [editing, setEditing] = useState(false);
  const [showSnippet, setShowSnippet] = useState(false);
  const [name, setName] = useState(site.name);
  const [goals, setGoals] = useState(site.goals.join(", "));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const snippet = siteSnippet({ origin: window.location.origin, clientId, siteId: site.id });
  const on = site.status === "on";
  const t = `marketing-sites-${site.id}`;

  async function update(change: Record<string, unknown>, done: string) {
    setBusy(true);
    setNote(null);
    try {
      await runMarketingAction(api, clientId, "update-site", { siteId: site.id, ...change });
      setNote(done);
      setEditing(false);
      onSaved();
    } catch (error) {
      setNote(failure(error));
    } finally {
      setBusy(false);
    }
  }

  const parsed = parseGoals(goals);
  const badGoal = parsed.find((g) => !GOAL_NAME.test(g));
  return (
    <Card
      title={site.name}
      meta={
        <Badge tone={on ? "positive" : "neutral"} testId={`${t}-status`}>
          {on ? "Measuring" : "Switched off"}
        </Badge>
      }
      testId={t}
    >
      <div className="ui-card__body flex flex-col gap-4">
        <p className="break-all text-ink-muted">{site.domain}</p>
        <p className="text-sm text-ink" data-testid={`${t}-figures`}>
          {site.dataThrough
            ? `${countWords(site.visitsLast7)} visits in the last 7 days. Counted to ${dayWords(site.dataThrough)}.`
            : site.lastEventDay
              ? `First visits arrived ${dayWords(site.lastEventDay)}; they are counted overnight.`
              : "No visits yet. Paste the snippet into every page of the site."}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-ink-muted">Goals:</span>
          {site.goals.length === 0 ? (
            <span className="text-sm text-ink-muted">none yet</span>
          ) : (
            site.goals.map((g) => <Tag key={g}>{g}</Tag>)
          )}
        </div>

        {editing ? (
          <div className="flex flex-col gap-3" data-testid={`${t}-form`}>
            <div className="flex flex-wrap gap-4">
              <Field label="Name" className="min-w-0 flex-1 basis-56">
                <TextInput
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  data-testid={`${t}-name`}
                />
              </Field>
              <Field
                label="Goals"
                hint="The data-track names whose click counts as a goal, separated by commas."
                error={
                  badGoal
                    ? `${badGoal} isn't a data-track name: lower case, digits and hyphens.`
                    : undefined
                }
                className="min-w-0 flex-1 basis-56"
              >
                <TextInput
                  value={goals}
                  onChange={(e) => setGoals(e.target.value)}
                  data-testid={`${t}-goals`}
                />
              </Field>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                disabled={busy || !name.trim() || Boolean(badGoal) || parsed.length > 20}
                onClick={() => void update({ name: name.trim(), goals: parsed }, "Saved.")}
                data-testid={`${t}-save`}
              >
                Save
              </Button>
              <Button variant="ghost" onClick={() => setEditing(false)} data-testid={`${t}-cancel`}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {!editing ? (
            <Button size="sm" onClick={() => setEditing(true)} data-testid={`${t}-edit`}>
              Change name or goals
            </Button>
          ) : null}
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              void update({ status: on ? "off" : "on" }, on ? "Switched off." : "Switched on.")
            }
            data-testid={`${t}-switch`}
          >
            {on ? "Switch off" : "Switch on"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowSnippet((v) => !v)}
            data-testid={`${t}-snippet-toggle`}
          >
            {showSnippet ? "Hide the snippet" : "Show the snippet"}
          </Button>
        </div>
        {note ? (
          <p role="status" className="text-sm text-ink-muted">
            {note}
          </p>
        ) : null}

        {showSnippet ? (
          <div className="flex flex-col gap-2" data-testid={`${t}-snippet`}>
            <p className="text-sm text-ink">
              Paste this before <code>&lt;/body&gt;</code> on every page of {site.domain}. Mark what
              to count with <code>data-track="name"</code>; a goal is one of those names.
            </p>
            <pre className="max-h-64 overflow-auto rounded-sm border border-line bg-surface-subtle p-3 text-xs">
              <code data-testid={`${t}-snippet-code`}>{snippet}</code>
            </pre>
            <div>
              <CopySnippet value={snippet} testId={`${t}-snippet-copy`} />
            </div>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function AddSite({ clientId, onAdded }: { clientId: string; onAdded: () => void }) {
  const api = useApiClient();
  const [domain, setDomain] = useState("");
  const [name, setName] = useState("");
  const [goals, setGoals] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const parsed = parseGoals(goals);
  const badGoal = parsed.find((g) => !GOAL_NAME.test(g));

  async function add() {
    setBusy(true);
    setNote(null);
    try {
      await runMarketingAction(api, clientId, "add-site", {
        domain: domain.trim(),
        name: name.trim() || domain.trim(),
        goals: parsed,
      });
      setDomain("");
      setName("");
      setGoals("");
      setNote("Added. Show its snippet to measure it.");
      onAdded();
    } catch (error) {
      setNote(failure(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Add a site" testId="marketing-sites-add">
      <Card pad>
        <div className="flex flex-wrap gap-4">
          <Field
            label="Website"
            hint="Its address, e.g. example.com"
            className="min-w-0 flex-1 basis-56"
          >
            <TextInput
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              data-testid="marketing-sites-add-domain"
            />
          </Field>
          <Field label="Name" hint="As we call it here" className="min-w-0 flex-1 basis-56">
            <TextInput
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="marketing-sites-add-name"
            />
          </Field>
          <Field
            label="Goals"
            hint="Optional: data-track names, separated by commas"
            error={badGoal ? `${badGoal} isn't a data-track name.` : undefined}
            className="min-w-0 flex-1 basis-56"
          >
            <TextInput
              value={goals}
              onChange={(e) => setGoals(e.target.value)}
              data-testid="marketing-sites-add-goals"
            />
          </Field>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            disabled={busy || domain.trim().length < 3 || Boolean(badGoal)}
            onClick={() => void add()}
            data-testid="marketing-sites-add-save"
          >
            Add site
          </Button>
          {note ? (
            <span role="status" className="text-sm text-ink-muted">
              {note}
            </span>
          ) : null}
        </div>
      </Card>
    </Section>
  );
}

function SampleTraffic({ clientId, onFilled }: { clientId: string; onFilled: () => void }) {
  const api = useApiClient();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  async function fill() {
    setBusy(true);
    setNote(null);
    try {
      const r = await runMarketingAction<{ sample: { visits: number; days: number } }>(
        api,
        clientId,
        "sample-traffic",
        {},
      );
      setNote(`Filled ${r.sample.days} days with ${countWords(r.sample.visits)} sample visits.`);
      onFilled();
    } catch (error) {
      setNote(failure(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section title="Sample traffic" testId="marketing-sites-sample">
      <Card pad>
        <p className="text-ink">
          The Sandbox has no real visitors. Fill its first site's last 28 days with sample visits,
          replacing what those days had, so every screen has figures to show.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button
            disabled={busy}
            onClick={() => void fill()}
            data-testid="marketing-sites-sample-fill"
          >
            Fill with sample traffic
          </Button>
          {note ? (
            <span
              role="status"
              className="text-sm text-ink-muted"
              data-testid="marketing-sites-sample-note"
            >
              {note}
            </span>
          ) : null}
        </div>
      </Card>
    </Section>
  );
}
