// The ROMCO demo: the portal as ROMCO's VP of Sales sees it, for the UCC filings review, clickable
// end to end with no server. A memory router (the SOP's own `#section` links stay page anchors); a
// fake API client so the real components' "This is wrong" form answers; the real styles.
import type { ReactNode } from "react";
import {
  Link,
  MemoryRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useSearchParams,
} from "react-router-dom";
import { createApiClient } from "../../api/client";
import { ApiProvider } from "../../api/useApi";
import { AgentBadge } from "../../ui/badges";
import { IconSprite } from "../../ui/icons";
import { Page } from "../../ui/page";
import { buttonClass, Card, PageHeader } from "../../ui/primitives";
import { StatusChip } from "../../ui/status";
import { AgentPage, runChip } from "./AgentPage";
import { DemoShell, ScrollOnMove } from "./DemoShell";
import { Inbox } from "./Inbox";
import { InvoicePage, invoiceChip } from "./invoice/InvoicePage";
import { InvoiceRun } from "./invoice/InvoiceRun";
import { DealsForm, RegisterUpload } from "./invoice/Pages";
import { Mail } from "./Mail";
import { INVOICE_ID, UCC_ID } from "./people";
import { ReviewForm } from "./ReviewForm";
import { RunPage } from "./RunPage";
import { AGENT, DemoProvider, INV_AGENT, UCC_STOPS, useDemo } from "./state";
import "./demo.css";

/** Answers like the Worker for the one write the real components make here. */
const api = createApiClient({
  fetch: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), "http://demo.local");
    const body =
      init.method === "POST" && url.pathname.endsWith("/manual/feedback")
        ? { request: { id: "00000000-0000-4000-8000-0000000000aa", number: 214 } }
        : { error: "not_found" };
    return new Response(JSON.stringify(body), {
      status: "request" in body ? 200 : 404,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch,
});

const WHERE = "mezonas-demo-romco-where";

function firstPlace(): string {
  try {
    return sessionStorage.getItem(WHERE) ?? (UCC_STOPS[0]?.path as string);
  } catch {
    return UCC_STOPS[0]?.path as string;
  }
}

function RememberPlace() {
  const { pathname, hash } = useLocation();
  try {
    sessionStorage.setItem(WHERE, `${pathname}${hash}`);
  } catch {
    // No storage: a reload starts the tour again.
  }
  return null;
}

export function DemoApp() {
  return (
    <ApiProvider client={api}>
      <DemoProvider>
        <MemoryRouter initialEntries={[firstPlace()]}>
          <IconSprite />
          <ScrollOnMove />
          <RememberPlace />
          <Routes>
            <Route path="/f/marcus" element={<ReviewForm />} />
            <Route path="/f/deals" element={<DealsForm />} />
            <Route path="/r/register" element={<RegisterUpload />} />
            <Route path="/mail/:which" element={<Mail />} />
            <Route path="*" element={<InShell />} />
          </Routes>
        </MemoryRouter>
      </DemoProvider>
    </ApiProvider>
  );
}

function InShell() {
  return (
    <DemoShell>
      <Routes>
        <Route path={AGENT} element={<AgentPage tab="overview" />} />
        <Route path={`${AGENT}/runs`} element={<AgentPage tab="runs" />} />
        <Route path={`${AGENT}/flow`} element={<AgentPage tab="flow" />} />
        <Route path={`${AGENT}/sop`} element={<AgentPage tab="sop" />} />
        <Route path={`${AGENT}/report`} element={<AgentPage tab="report" />} />
        <Route path={`${AGENT}/settings`} element={<AgentPage tab="settings" />} />
        <Route path={INV_AGENT} element={<InvoicePage tab="overview" />} />
        <Route path={`${INV_AGENT}/runs`} element={<InvoicePage tab="runs" />} />
        <Route path={`${INV_AGENT}/flow`} element={<InvoicePage tab="flow" />} />
        <Route path={`${INV_AGENT}/sop`} element={<InvoicePage tab="sop" />} />
        <Route path={`${INV_AGENT}/report`} element={<InvoicePage tab="report" />} />
        <Route path={`${INV_AGENT}/settings`} element={<InvoicePage tab="settings" />} />
        <Route path="/runs/R-1051/:step" element={<InvoiceRun />} />
        <Route path="/runs/:run/:step" element={<RunPage />} />
        <Route path="/runs" element={<Navigate to="/runs/R-1042/receive" replace />} />
        <Route path="/inbox" element={<Inbox />} />
        <Route path="/home" element={<Home />} />
        <Route path="/sloan" element={<Sloan />} />
        <Route path="*" element={<Elsewhere />} />
      </Routes>
    </DemoShell>
  );
}

function Home() {
  const { state } = useDemo();
  const chip = runChip(state);
  return (
    <Page>
      <PageHeader
        eyebrow="Monday, November 3"
        title="Good morning, Dana"
        subtitle="Your two agents at ROMCO."
      />
      <div className="ui-cols ui-cols--2">
        <AgentCard
          to={AGENT}
          id={UCC_ID}
          name="UCC filings review"
          line="138 sales found in October · ROMCO saw 30%"
          chip={<StatusChip state={chip.state}>{chip.label}</StatusChip>}
        />
        <AgentCard
          to={`/agents/${INVOICE_ID}`}
          id={INVOICE_ID}
          name="Invoice CRM update"
          line="Daily: 7 of 9 of yesterday's sales reconciled; deals closed in Zoho CRM"
          chip={
            <StatusChip state={invoiceChip(state.inv).state}>
              {invoiceChip(state.inv).label}
            </StatusChip>
          }
        />
      </div>
    </Page>
  );
}

function AgentCard({
  to,
  id,
  name,
  line,
  chip,
}: {
  to: string;
  id: string;
  name: string;
  line: string;
  chip: ReactNode;
}) {
  return (
    <Link to={to} className="ds-card demo-agentcard">
      <AgentBadge name={name} seed={id} />
      <span className="min-w-0 flex-1">
        <b className="block text-ink">{name}</b>
        <span className="block text-sm text-ink-muted">{line}</span>
        <span className="mt-2 block">{chip}</span>
      </span>
    </Link>
  );
}

/** Sloan, the account agent, answering what "Ask about this" quoted. */
function Sloan() {
  const [params] = useSearchParams();
  const ask = params.get("ask") ?? "What does the UCC filings review do?";
  return (
    <Page width="narrow">
      <PageHeader
        leading={<AgentBadge name="Sloan" size="lg" />}
        title="Sloan"
        subtitle="Your account agent. Ask it anything."
      />
      <div className="flex flex-col gap-4">
        <div className="demo-bubble demo-bubble--you">{ask}</div>
        <div className="demo-bubble">
          <p>
            That's part of the UCC filings review's SOP (SOP-SAL-04, revision 0.3). It runs on rules
            first; AI steps use Claude Sonnet 5.5 and the analysis uses Claude Opus 5.5. Nothing is
            emailed until you sign, and the agent can only read Zoho CRM.
          </p>
          <p className="mt-2">
            If something in it should change, use "This is wrong" on the line and we'll pick it up
            with you.
          </p>
        </div>
        <Link to={`${AGENT}/sop`} className={buttonClass("secondary", "self-start")}>
          Back to the SOP
        </Link>
      </div>
    </Page>
  );
}

function Elsewhere() {
  return (
    <Page width="narrow">
      <Card pad>
        <p className="text-ink">This part of the portal isn't in the demo.</p>
        <Link to={AGENT} className={buttonClass("primary", "mt-4")}>
          Back to the UCC filings review
        </Link>
      </Card>
    </Page>
  );
}
