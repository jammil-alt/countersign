// The ROMCO demo: the portal as ROMCO's VP of Sales sees it, for the UCC filings review, clickable
// end to end with no server. A memory router (the SOP's own `#section` links stay page anchors); a
// fake API client so the real components' "This is wrong" form answers; the real styles.
import type { ReactNode } from "react";
import { Link, MemoryRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
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
import { SloanPage, SloanProvider } from "./Sloan";
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
          <SloanProvider>
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
          </SloanProvider>
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
        <Route path="/sloan" element={<SloanPage />} />
        <Route path="/sloan/change" element={<SloanPage change />} />
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
