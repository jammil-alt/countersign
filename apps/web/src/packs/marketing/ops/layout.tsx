// The frame of a client's Marketing pages in the back office (docs/marketing-plan.md §4.7, §11):
// the client's name under "Marketing", the area's sub-navigation (a row that scrolls inside itself
// on a phone), and the page's own heading. Every screen in this folder renders inside it. The
// client's name comes from the frame's clients list, so the layout loads nothing of its own.
import type { ReactNode } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { useClientSummary } from "../../../ops/OpsLayout";
import { Page } from "../../../ui/page";
import { PageHeader, Tabs, Tag } from "../../../ui/primitives";
import { MARKETING_NAV, MARKETING_PATHS, sectionOf } from "./paths";

/** The client the page is for, from the route (`/ops/clients/:clientId/marketing/…`). */
export function useMarketingClientId(): string {
  const { clientId = "" } = useParams();
  return clientId;
}

export function MarketingLayout({
  title,
  subtitle,
  actions,
  testId,
  children,
}: {
  /** The page's own heading, e.g. "Pages". */
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  testId?: string;
  children: ReactNode;
}) {
  const clientId = useMarketingClientId();
  const client = useClientSummary(clientId);
  const { pathname } = useLocation();
  const at = sectionOf(pathname, clientId);
  return (
    <Page testId="marketing-page">
      <div>
        <PageHeader
          eyebrow={
            <Link to={MARKETING_PATHS.entry} className="hover:underline">
              Marketing
            </Link>
          }
          title={client?.name ?? "Marketing"}
          badge={client?.internal ? <Tag>Ours</Tag> : null}
        />
        <div data-testid="marketing-nav">
          <Tabs
            items={MARKETING_NAV.map((s) => ({
              to: MARKETING_PATHS[s.id](clientId),
              label: s.label,
              end: true,
              active: s.id === at,
            }))}
          />
        </div>
      </div>
      <section data-testid={testId}>
        <PageHeader title={title} subtitle={subtitle} actions={actions} />
        {children}
      </section>
    </Page>
  );
}

/** A screen whose milestone hasn't come yet: its heading, and when it comes. */
export function ComingScreen({
  title,
  milestone,
  line,
  testId,
}: {
  title: string;
  /** e.g. "M44". */
  milestone: string;
  /** What the screen will show, in one plain line. */
  line: string;
  testId: string;
}) {
  return (
    <MarketingLayout title={title} testId={testId}>
      <div className="ds-empty" data-testid={`${testId}-coming`}>
        <p className="font-medium text-ink">Coming in {milestone}</p>
        <p className="text-ink-muted">{line}</p>
      </div>
    </MarketingLayout>
  );
}
