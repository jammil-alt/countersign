// A guide (M46, docs/plan.md §1.76): the editor (title and description with their counters, the
// fixed address, the Markdown body, the target queries with their search figures), checked as
// you type exactly as publishing checks it, the page as the site would show it and as a search
// result would, a preview link, every version (an agent's with its reasons and sources) with
// restore, and Publish: the person who presses it signs the change, which goes through the
// client's Website connection as one external action. Text from agents is shown as text.
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiRoutes } from "../../../api/routes";
import { useApiClient } from "../../../api/useApi";
import { Field, TextArea, TextInput } from "../../../ui/forms";
import {
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  SectionLabel,
  Tag,
} from "../../../ui/primitives";
import { runMarketingAction, useMarketingItem } from "./api";
import { dayOf, guideChip, type WebsiteState } from "./Content";
import { MarketingLayout, useMarketingClientId } from "./layout";
import { MARKETING_PATHS } from "./paths";

export const TITLE_MAX = 60;
export const DESCRIPTION_MAX = 155;

export interface Problem {
  field: "title" | "description" | "body";
  code: string;
  severity: "refuse" | "check";
  message: string;
  match?: string;
}

export interface CheckResult {
  html: string;
  headings: { level: number; text: string; id: string }[];
  problems: Problem[];
  words: number;
  publishable: boolean;
}

export interface GuideVersion {
  id: string;
  version: number;
  title: string;
  description: string;
  body: string;
  targetQueries: string[];
  author: "person" | "agent";
  why: string | null;
  createdAt: string;
  live: boolean;
}

export interface GuideDetail {
  page: {
    id: string;
    siteId: string;
    path: string;
    slug: string | null;
    status: "draft" | "published" | "unpublished";
    createdBy: "person" | "agent";
    createdAt: string;
    addressFixed: boolean;
  };
  site: { id: string; domain: string; name: string } | null;
  liveVersion: number | null;
  versions: GuideVersion[];
  publishes: { id: string; action: string; version: number | null; at: string }[];
  check: CheckResult | null;
  queries: {
    query: string;
    impressions: number;
    clicks: number;
    position: string | null;
    inTitle: boolean;
  }[];
  website: WebsiteState;
}

interface Draft {
  title: string;
  description: string;
  body: string;
  queries: string;
}

const draftOf = (v: GuideVersion | undefined): Draft => ({
  title: v?.title ?? "",
  description: v?.description ?? "",
  body: v?.body ?? "",
  queries: (v?.targetQueries ?? []).join("\n"),
});

const queriesOf = (text: string) =>
  text
    .split(/\n|,/)
    .map((q) => q.trim())
    .filter(Boolean)
    .slice(0, 10);

const errorText = (e: unknown) => (e instanceof Error ? e.message : "That didn't work.");

function Counter({ n, max, testId }: { n: number; max: number; testId: string }) {
  return (
    <span className={n > max ? "ui-tone-risk" : "text-ink-muted"} data-testid={testId}>
      {n} of {max}
    </span>
  );
}

/** What a search result would show: the title and description cut where a result cuts them. */
function SearchResult({ domain, path, draft }: { domain: string; path: string; draft: Draft }) {
  const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
  return (
    <div className="flex flex-col gap-1" data-testid="marketing-content-page-serp">
      <span className="text-sm text-ink-muted">
        {domain}
        {path.replace(/\//g, " › ")}
      </span>
      <span className="font-medium text-ink">{cut(draft.title, TITLE_MAX) || "Untitled"}</span>
      <span className="text-sm text-ink-muted">{cut(draft.description, DESCRIPTION_MAX)}</span>
    </div>
  );
}

function Problems({ check }: { check: CheckResult | null }) {
  if (!check) return null;
  if (check.problems.length === 0) {
    return (
      <p className="text-ink" data-testid="marketing-content-page-checks-clear">
        Every check passes. {check.words} words.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-2" data-testid="marketing-content-page-problems">
      {check.problems.map((p) => (
        <li key={`${p.field}:${p.code}:${p.match ?? ""}`} className="flex flex-col">
          <span className={p.severity === "refuse" ? "ui-tone-risk" : "ui-tone-signal"}>
            {p.severity === "refuse" ? "Blocks publishing" : "Check before publishing"} · {p.field}
          </span>
          <span className="text-ink">{p.message}</span>
          {p.match ? <span className="text-sm text-ink-muted">“{p.match}”</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** The page as the site would show it, in a sandboxed frame (no scripts, nothing it can reach). */
function Rendered({ title, html }: { title: string; html: string }) {
  const doc = `<!doctype html><meta charset="utf-8"><style>body{font-family:system-ui,sans-serif;line-height:1.6;margin:16px}</style><h1>${title.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}</h1>${html}`;
  return (
    <iframe
      title="The guide as the site would show it"
      sandbox=""
      srcDoc={doc}
      className="h-96 w-full rounded-md border border-line"
      data-testid="marketing-content-page-preview"
    />
  );
}

function Editor({
  clientId,
  detail,
  onSaved,
}: {
  clientId: string;
  detail: GuideDetail;
  onSaved: () => void;
}) {
  const api = useApiClient();
  const newest = detail.versions[0];
  const [draft, setDraft] = useState<Draft>(() => draftOf(newest));
  const [why, setWhy] = useState("");
  const [check, setCheck] = useState<CheckResult | null>(detail.check);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<"publish" | "unpublish" | null>(null);
  const [preview, setPreview] = useState<{ url: string; expiresAt: string } | null>(null);
  const loadedFor = useRef(newest?.id);

  // A newer version arrived (saved here, or an agent's): the editor starts from it.
  useEffect(() => {
    if (newest?.id !== loadedFor.current) {
      loadedFor.current = newest?.id;
      setDraft(draftOf(newest));
      setCheck(detail.check);
    }
  }, [newest, detail.check]);

  const saved = draftOf(newest);
  const unsaved =
    draft.title !== saved.title ||
    draft.description !== saved.description ||
    draft.body !== saved.body ||
    queriesOf(draft.queries).join("\n") !== queriesOf(saved.queries).join("\n");

  // The words on screen, checked as publishing checks them, half a second after typing stops.
  useEffect(() => {
    if (!unsaved) return;
    const timer = setTimeout(() => {
      runMarketingAction<CheckResult>(api, clientId, "check", {
        page: detail.page.id,
        title: draft.title,
        description: draft.description,
        body: draft.body,
      })
        .then(setCheck)
        .catch(() => {});
    }, 500);
    return () => clearTimeout(timer);
  }, [api, clientId, detail.page.id, draft.title, draft.description, draft.body, unsaved]);

  const act = async (key: string, run: () => Promise<unknown>) => {
    setBusy(key);
    setProblem(null);
    setDone(null);
    try {
      await run();
      return true;
    } catch (e) {
      setProblem(errorText(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    act("save", async () => {
      await runMarketingAction(api, clientId, "save-version", {
        page: detail.page.id,
        title: draft.title,
        description: draft.description,
        body: draft.body,
        targetQueries: queriesOf(draft.queries),
        ...(why.trim() ? { why: why.trim() } : {}),
      });
      setWhy("");
      setDone("Saved as a new version.");
      onSaved();
    });

  const restore = (v: GuideVersion) =>
    act(`restore-${v.id}`, async () => {
      await runMarketingAction(api, clientId, "save-version", {
        page: detail.page.id,
        title: v.title,
        description: v.description,
        body: v.body,
        targetQueries: v.targetQueries,
        why: `Restored version ${v.version}.`,
      });
      setDone(`Version ${v.version} restored as a new version.`);
      onSaved();
    });

  const publish = () =>
    act("publish", async () => {
      const r = await runMarketingAction<{ url: string }>(api, clientId, "publish", {
        page: detail.page.id,
        ...(newest ? { version: newest.id } : {}),
      });
      setConfirming(null);
      setDone(`Live at ${r.url}.`);
      onSaved();
    });

  const unpublish = () =>
    act("unpublish", async () => {
      await runMarketingAction(api, clientId, "unpublish", { page: detail.page.id });
      setConfirming(null);
      setDone("Taken down. Its versions are kept.");
      onSaved();
    });

  const previewLink = () =>
    act("preview", async () => {
      if (!newest) return;
      // The platform's preview links: signed, noindex, for a day.
      const r = await api.call(apiRoutes.opsClientPackPreview, {
        params: { id: clientId, pack: "marketing" },
        body: { report: "content-preview", itemId: newest.id },
      });
      setPreview(r);
    });

  const domain = detail.site?.domain ?? "";
  const address = `https://${domain}${detail.page.path}`;
  const live = detail.page.status === "published";
  const canPublish =
    !unsaved && Boolean(check?.publishable) && detail.website.pointsHere && Boolean(newest);
  const whyNot = unsaved
    ? "Save your changes first: publishing sends the saved version."
    : !detail.website.pointsHere
      ? "The client's Website connection isn't pointed at this site (Content page)."
      : check && !check.publishable
        ? "A check blocks publishing."
        : null;

  return (
    <div className="flex flex-col gap-6">
      <Card title="The guide" testId="marketing-content-page-editor" pad>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1" data-testid="marketing-content-page-address">
            <span className="text-sm font-medium text-ink">Address</span>
            <span className="text-ink">{address}</span>
            <span className="text-sm text-ink-muted">
              Fixed: a guide keeps its address. One that must move is a new guide and a redirect.
            </span>
          </div>
          <Field
            label={
              <span className="flex justify-between gap-2">
                Title{" "}
                <Counter
                  n={draft.title.trim().length}
                  max={TITLE_MAX}
                  testId="marketing-content-page-title-count"
                />
              </span>
            }
          >
            <TextInput
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              invalid={draft.title.trim().length > TITLE_MAX}
              data-testid="marketing-content-page-title-input"
            />
          </Field>
          <Field
            label={
              <span className="flex justify-between gap-2">
                Description{" "}
                <Counter
                  n={draft.description.trim().length}
                  max={DESCRIPTION_MAX}
                  testId="marketing-content-page-description-count"
                />
              </span>
            }
            hint="What a search result shows under the title."
          >
            <TextArea
              rows={2}
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              invalid={draft.description.trim().length > DESCRIPTION_MAX}
              data-testid="marketing-content-page-description-input"
            />
          </Field>
          <Field
            label="Body"
            hint="Markdown: ## for sections (the title is the page's only top heading), - for lists, [words](/path) for links."
          >
            <TextArea
              rows={16}
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              className="font-mono"
              data-testid="marketing-content-page-body-input"
            />
          </Field>
          <Field label="Searches it is written for" hint="One per line, ten at most.">
            <TextArea
              rows={3}
              value={draft.queries}
              onChange={(e) => setDraft({ ...draft, queries: e.target.value })}
              data-testid="marketing-content-page-queries-input"
            />
          </Field>
          <Field label="Why this version (optional)">
            <TextInput
              value={why}
              onChange={(e) => setWhy(e.target.value)}
              data-testid="marketing-content-page-why-input"
            />
          </Field>
          {problem ? (
            <p className="ui-tone-risk" role="alert" data-testid="marketing-content-page-error">
              {problem}
            </p>
          ) : null}
          {done ? (
            <p className="text-ink" role="status" data-testid="marketing-content-page-done">
              {done}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              disabled={!unsaved || busy !== null}
              onClick={save}
              data-testid="marketing-content-page-save"
            >
              Save as a new version
            </Button>
            <Button
              disabled={busy !== null || !newest}
              onClick={previewLink}
              data-testid="marketing-content-page-preview-link"
            >
              Get a preview link
            </Button>
            <Button
              variant="primary"
              disabled={!canPublish || busy !== null}
              onClick={() => setConfirming("publish")}
              data-testid="marketing-content-page-publish"
            >
              {live ? "Publish this version" : "Publish"}
            </Button>
            {live ? (
              <Button
                disabled={busy !== null}
                onClick={() => setConfirming("unpublish")}
                data-testid="marketing-content-page-unpublish"
              >
                Take it down
              </Button>
            ) : null}
          </div>
          {whyNot ? <p className="text-sm text-ink-muted">{whyNot}</p> : null}
          {preview ? (
            <p className="text-sm text-ink" data-testid="marketing-content-page-preview-url">
              Preview (not public, not indexed, until {dayOf(preview.expiresAt)}):{" "}
              <a href={preview.url} target="_blank" rel="noreferrer" className="underline">
                {preview.url}
              </a>
            </p>
          ) : null}
        </div>
      </Card>

      {confirming ? (
        <Card
          title={confirming === "publish" ? "Sign and publish" : "Sign and take it down"}
          testId="marketing-content-page-confirm"
          pad
        >
          <div className="flex flex-col gap-3">
            <p className="text-ink">
              {confirming === "publish"
                ? `Version ${newest?.version} goes live at ${address} as soon as you sign, with the site's sitemap.`
                : `${address} comes off the site and out of its sitemap as soon as you sign. Every version is kept.`}
            </p>
            <p className="text-sm text-ink-muted">
              You are signing this change yourself. It is recorded with your name and what the page
              was before.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                disabled={busy !== null}
                onClick={confirming === "publish" ? publish : unpublish}
                data-testid="marketing-content-page-confirm-sign"
              >
                Sign
              </Button>
              <Button
                disabled={busy !== null}
                onClick={() => setConfirming(null)}
                data-testid="marketing-content-page-confirm-cancel"
              >
                Not now
              </Button>
            </div>
          </div>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card title="Checks" testId="marketing-content-page-checks" pad>
          <Problems check={check} />
        </Card>
        <Card title="In a search result" pad>
          <SearchResult domain={domain} path={detail.page.path} draft={draft} />
        </Card>
      </div>

      <section>
        <SectionLabel>The page</SectionLabel>
        <Rendered title={draft.title} html={check?.html ?? ""} />
      </section>

      <section data-testid="marketing-content-page-queries">
        <SectionLabel>Searches, last 28 days of search data</SectionLabel>
        {detail.queries.length === 0 ? (
          <EmptyState>No searches named yet. Add the ones this guide answers.</EmptyState>
        ) : (
          <div className="dt dt-ana">
            <div className="dt-scroll">
              <table>
                <thead>
                  <tr className="dt-cols">
                    <th>Search</th>
                    <th className="n">Impressions</th>
                    <th className="n">Clicks</th>
                    <th className="n">Position</th>
                    <th>In the title</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.queries.map((q) => (
                    <tr key={q.query}>
                      <td>{q.query}</td>
                      <td className="n">{q.impressions}</td>
                      <td className="n">{q.clicks}</td>
                      <td className="n">{q.position ?? "–"}</td>
                      <td>{q.inTitle ? "Yes" : "No"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      <section data-testid="marketing-content-page-versions">
        <SectionLabel>Versions</SectionLabel>
        <ul className="flex flex-col gap-3">
          {detail.versions.map((v) => (
            <li key={v.id} className="ds-card ui-card__body flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-ink">Version {v.version}</span>
                {v.live ? <Tag>Live</Tag> : null}
                <span className="text-sm text-ink-muted">
                  {v.author === "agent" ? "An agent's draft" : "A person's edit"} ·{" "}
                  {dayOf(v.createdAt)}
                </span>
                {v.id !== newest?.id ? (
                  <Button
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => restore(v)}
                    data-testid="marketing-content-page-version-restore"
                  >
                    Restore
                  </Button>
                ) : null}
              </div>
              <span className="text-ink">{v.title || "Untitled"}</span>
              {v.why ? <p className="whitespace-pre-wrap text-sm text-ink-muted">{v.why}</p> : null}
            </li>
          ))}
        </ul>
      </section>

      {detail.publishes.length > 0 ? (
        <section data-testid="marketing-content-page-publishes">
          <SectionLabel>Published and taken down</SectionLabel>
          <ul className="flex flex-col gap-1">
            {detail.publishes.map((p) => (
              <li key={p.id} className="text-ink">
                {p.action === "publish" ? "Published" : "Taken down"}
                {p.version ? ` version ${p.version}` : ""} · {dayOf(p.at)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

export function MarketingContentPageScreen() {
  const clientId = useMarketingClientId();
  const { pageId = "" } = useParams();
  const state = useMarketingItem<GuideDetail>(clientId, "content", pageId);
  const data = state.data;
  return (
    <MarketingLayout
      title={data?.versions[0]?.title || "Guide"}
      subtitle={
        data ? (
          <span className="flex flex-wrap items-center gap-2">
            {guideChip({
              status: data.page.status,
              changedSinceLive:
                data.page.status === "published" && data.liveVersion !== data.versions[0]?.version,
            })}
            <Link to={MARKETING_PATHS.content(clientId)} className="hover:underline">
              All guides
            </Link>
          </span>
        ) : null
      }
      testId="marketing-content-page"
    >
      {state.loading && !data ? <Loading /> : null}
      {state.error ? <ErrorNotice error={state.error} onRetry={state.reload} /> : null}
      {data ? <Editor clientId={clientId} detail={data} onSaved={state.reload} /> : null}
    </MarketingLayout>
  );
}
