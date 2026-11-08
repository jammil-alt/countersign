// One visit (M44, `visits/:visit?day=…`): where it came from, where it was, on what, and the steps
// it took, in order: each page with the time engaged on it and how far down it got, each tracked
// click (a goal marked) and each form that came into sight. Its day only, never a time of day. The
// steps are kept 90 days; after that only the summary is left.
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Loaded, Section } from "../../../ui/page";
import { Card, EmptyState, Tag } from "../../../ui/primitives";
import { useMarketingReport } from "./api";
import {
  dayWords,
  durationWords,
  MarketingLayout,
  type MarketingSite,
  useKeptQuery,
  useMarketingClientId,
  withKept,
} from "./layout";
import { sourceWords } from "./Overview";
import { MARKETING_PATHS } from "./paths";
import { placeWords, type VisitRow } from "./Visits";

interface VisitStep {
  kind: "view" | "click" | "form_seen";
  path: string;
  engagedMs: number | null;
  scroll: number | null;
  target: string | null;
  position: number | null;
  goal: boolean;
  form: string | null;
}

export interface VisitReport {
  site: MarketingSite | null;
  sites: MarketingSite[];
  day: string;
  visit:
    | (VisitRow & {
        browser: string | null;
        os: string | null;
        language: string | null;
        referrerHost: string | null;
        utmCampaign: string | null;
        utmContent: string | null;
        clicks: number;
        sawForm: boolean;
      })
    | null;
  steps: VisitStep[] | null;
}

function stepWords(s: VisitStep): string {
  if (s.kind === "view") {
    const reach = s.scroll ? `, read to ${s.scroll * 25}%` : "";
    return `Read ${s.path}: ${durationWords(s.engagedMs)} engaged${reach}`;
  }
  if (s.kind === "click") return `Clicked ${s.target} (${s.position}% down the page)`;
  return `Saw the ${s.form} form`;
}

export function MarketingVisitScreen() {
  const clientId = useMarketingClientId();
  const { visit = "" } = useParams();
  const [params] = useSearchParams();
  const day = params.get("day") ?? "";
  const kept = useKeptQuery();
  const ok = /^[0-9a-f]{32}$/.test(visit) && /^\d{4}-\d{2}-\d{2}$/.test(day);
  const state = useMarketingReport<VisitReport>(ok ? clientId : null, "visit", {
    site: params.get("site"),
    day,
    visit,
  });
  return (
    <MarketingLayout
      title={day && ok ? `A visit on ${dayWords(day, true)}` : "A visit"}
      subtitle={
        <Link
          to={withKept(MARKETING_PATHS.visits(clientId), kept)}
          className="text-link hover:underline"
        >
          All visits
        </Link>
      }
      testId="marketing-visit"
    >
      {!ok ? (
        <EmptyState testId="marketing-visit-missing" line="Open a visit from the list of visits." />
      ) : (
        <Loaded state={state}>
          {(r) =>
            !r.visit ? (
              <EmptyState
                testId="marketing-visit-missing"
                title="No such visit"
                line="Visits are kept 13 months."
              />
            ) : (
              <VisitBody r={r} v={r.visit} />
            )
          }
        </Loaded>
      )}
    </MarketingLayout>
  );
}

function VisitBody({ r, v }: { r: VisitReport; v: NonNullable<VisitReport["visit"]> }) {
  const facts: [string, string][] = [
    ["Came from", sourceWords(v.sourceGroup, v.sourceName)],
    ...(v.utmCampaign
      ? ([["Campaign", `${v.utmCampaign}${v.utmContent ? `, ${v.utmContent}` : ""}`]] as [
          string,
          string,
        ][])
      : []),
    ["Where", placeWords(v)],
    ["On", [v.device, v.browser, v.os].filter(Boolean).join(", ")],
    ["Language", v.language ?? "Not known"],
    ["Pages read", String(v.views)],
    ["Engaged", durationWords(v.engagedMs)],
    ["Goal", v.goal ?? "None"],
  ];
  return (
    <div className="flex flex-col gap-6">
      <Card pad testId="marketing-visit-summary">
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
          {facts.map(([k, val]) => (
            <div key={k} className="flex min-w-0 flex-wrap gap-2">
              <dt className="text-ink-muted">{k}</dt>
              <dd className="min-w-0 break-words text-ink">{val}</dd>
            </div>
          ))}
        </dl>
        {v.reachedGoal ? (
          <p className="mt-3">
            <Tag>Reached a goal</Tag>
          </p>
        ) : null}
      </Card>
      <Section title="Steps" meta={`${dayWords(r.day)}, in order`} testId="marketing-visit-steps">
        {r.steps ? (
          <ol className="flex flex-col gap-2">
            {r.steps.map((s, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: steps are positional.
                key={i}
                className="flex min-w-0 items-baseline gap-3"
                data-testid={`marketing-visit-step-${i + 1}`}
              >
                <span className="figures w-6 shrink-0 text-right text-ink-muted">{i + 1}</span>
                <span className="min-w-0 break-words text-ink">
                  {stepWords(s)}
                  {s.goal ? (
                    <span className="ml-2">
                      <Tag>Goal</Tag>
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <div data-testid="marketing-visit-no-steps">
            <p className="text-sm text-ink-muted">
              The steps are kept 90 days. This visit read {v.pages.join(" → ")}.
            </p>
          </div>
        )}
      </Section>
    </div>
  );
}
