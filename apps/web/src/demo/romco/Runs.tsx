// The Runs page as the portal draws it (portal/screens/Runs.tsx): every run of both agents, newest
// first, with the ask box, the status tabs, the agent and started-by pickers, and a sortable
// table; each row opens its run. Runs that the demo tells in full (R-1042, R-1051) open their own
// pages; the others open a finished run's page, step by step, from that day's figures.
import { type FormEvent, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { StatusFilter } from "../../inbox/StatusFilter";
import { Select } from "../../ui/forms";
import { Icon } from "../../ui/icons";
import { Page } from "../../ui/page";
import { Button, PageHeader } from "../../ui/primitives";
import { type ChipState, StatusChip } from "../../ui/status";
import { RunRow } from "./AgentFrame";
import { runChip } from "./AgentPage";
import { DAYS } from "./invoice/data";
import { invoiceChip } from "./invoice/InvoicePage";
import { INVOICE_ID, UCC_ID } from "./people";
import { Facts, How, RunFrame, type RunFrameStep } from "./RunFrame";
import { type DemoState, useDemo } from "./state";

type Chip = { state: ChipState; label: string };

export interface RunEntry {
  id: string;
  agent: "ucc" | "invoice";
  title: string;
  started: string;
  /** For sorting: minutes since Oct 1. */
  at: number;
  took: string;
  startedBy: "An email" | "Schedule" | "Mezonas";
  chip: (s: DemoState) => Chip;
  to: string;
}

const AGENT_NAME = { ucc: "UCC filings review", invoice: "Invoice CRM update" } as const;
const AGENT_ID = { ucc: UCC_ID, invoice: INVOICE_ID } as const;
const DONE: Chip = { state: "done", label: "Done" };

/** The days before today's invoice run, newest first, with their run ids and how long each took. */
const PAST_DAYS: {
  id: string;
  day: string;
  covers: string;
  at: number;
  took: string;
  late: boolean;
}[] = [
  {
    id: "R-1047",
    day: "Wed Nov 5",
    covers: "Tue Nov 4",
    at: 35 * 1440 + 420,
    took: "3 hr 2 min",
    late: false,
  },
  {
    id: "R-1043",
    day: "Tue Nov 4",
    covers: "Mon Nov 3",
    at: 34 * 1440 + 420,
    took: "4 hr 41 min",
    late: false,
  },
  {
    id: "R-1039",
    day: "Mon Nov 3",
    covers: "Fri Oct 31",
    at: 33 * 1440 + 420,
    took: "6 hr 10 min",
    late: false,
  },
  {
    id: "R-1031",
    day: "Fri Oct 31",
    covers: "Thu Oct 30",
    at: 30 * 1440 + 420,
    took: "2 hr 55 min",
    late: false,
  },
  {
    id: "R-1027",
    day: "Thu Oct 30",
    covers: "Wed Oct 29",
    at: 29 * 1440 + 420,
    took: "7 hr 30 min",
    late: true,
  },
  {
    id: "R-1024",
    day: "Wed Oct 29",
    covers: "Tue Oct 28",
    at: 28 * 1440 + 420,
    took: "3 hr 18 min",
    late: false,
  },
  {
    id: "R-1020",
    day: "Tue Oct 28",
    covers: "Mon Oct 27",
    at: 27 * 1440 + 420,
    took: "2 hr 40 min",
    late: false,
  },
  {
    id: "R-1016",
    day: "Mon Oct 27",
    covers: "Fri Oct 24",
    at: 26 * 1440 + 420,
    took: "4 hr 5 min",
    late: false,
  },
  {
    id: "R-1012",
    day: "Fri Oct 24",
    covers: "Thu Oct 23",
    at: 23 * 1440 + 420,
    took: "3 hr 51 min",
    late: false,
  },
];

export const RUNS: RunEntry[] = [
  {
    id: "R-1051",
    agent: "invoice",
    title: "Thu Nov 6, for Wed Nov 5",
    started: "Nov 6, 7:00 AM",
    at: 36 * 1440 + 420,
    took: "–",
    startedBy: "Schedule",
    chip: (s) => invoiceChip(s.inv),
    to: "/runs/R-1051/collect",
  },
  ...PAST_DAYS.map(
    (d): RunEntry => ({
      id: d.id,
      agent: "invoice",
      title: `${d.day}, for ${d.covers}`,
      started: `${d.day.slice(4)}, 7:00 AM`,
      at: d.at,
      took: d.took,
      startedBy: "Schedule",
      chip: () => DONE,
      to: `/runs/${d.id}/collect`,
    }),
  ),
  {
    id: "R-1042",
    agent: "ucc",
    title: "October 2026 UCC file",
    started: "Nov 3, 8:02 AM",
    at: 33 * 1440 + 482,
    took: "–",
    startedBy: "An email",
    chip: (s) => runChip(s),
    to: "/runs/R-1042/receive",
  },
  {
    id: "R-0987",
    agent: "ucc",
    title: "September 2026 UCC file (test run)",
    started: "Oct 31, 2:10 PM",
    at: 30 * 1440 + 850,
    took: "11 min",
    startedBy: "Mezonas",
    chip: () => ({ state: "checked", label: "Test run" }),
    to: "/runs/R-0987/receive",
  },
];

type Tab = "all" | "going" | "waiting" | "done" | "notFinished";
const TAB_WORDS: [Tab, string][] = [
  ["all", "All"],
  ["going", "Running now"],
  ["waiting", "Needs you"],
  ["done", "Done"],
  ["notFinished", "Didn't finish"],
];
const IN_TAB: Record<Tab, ChipState[] | null> = {
  all: null,
  going: ["running"],
  waiting: ["waiting", "person"],
  done: ["done", "checked"],
  notFinished: ["failed", "blocked"],
};

type SortKey = "run" | "agent" | "started" | "took" | "status";

export function RunsList() {
  const { state } = useDemo();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("all");
  const [agent, setAgent] = useState("");
  const [startedBy, setStartedBy] = useState("");
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "started",
    dir: "desc",
  });

  const rows = useMemo(() => {
    const words = asked
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2);
    const shown = RUNS.filter((r) => {
      const chip = r.chip(state);
      const tabOk = IN_TAB[tab]?.includes(chip.state) ?? true;
      const text = `${r.id} ${r.title} ${AGENT_NAME[r.agent]} ${chip.label}`.toLowerCase();
      return (
        tabOk &&
        (!agent || r.agent === agent) &&
        (!startedBy || r.startedBy === startedBy) &&
        words.every((w) => text.includes(w))
      );
    });
    const value = (r: RunEntry): string | number =>
      sort.key === "run"
        ? r.title
        : sort.key === "agent"
          ? AGENT_NAME[r.agent]
          : sort.key === "status"
            ? r.chip(state).label
            : sort.key === "took"
              ? r.took
              : r.at;
    const sign = sort.dir === "asc" ? 1 : -1;
    return [...shown].sort((a, b) => {
      const x = value(a);
      const y = value(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sign;
    });
  }, [state, tab, agent, startedBy, asked, sort]);

  const head = (key: SortKey, label: string) => (
    <th aria-sort={sort.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        className="dt-sort"
        onClick={() =>
          setSort((old) =>
            old.key === key
              ? { key, dir: old.dir === "asc" ? "desc" : "asc" }
              : { key, dir: key === "started" ? "desc" : "asc" },
          )
        }
      >
        {label}
      </button>
    </th>
  );

  const ask = (e: FormEvent) => {
    e.preventDefault();
    setAsked(question.trim());
  };

  return (
    <Page>
      <PageHeader
        title="Runs"
        subtitle="Every time an agent worked for you: when it started, each step, what changed and who approved."
      />
      <form onSubmit={ask} className="ds-card ui-ask">
        <Icon name="search" className="text-ink-muted" />
        {asked ? <span className="ds-tag">words {asked}</span> : null}
        <input
          aria-label="Ask about your runs"
          value={question}
          maxLength={500}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder='Ask in plain words: "invoice runs this week"'
          className="ui-ask__input"
        />
        {asked ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setAsked("");
              setQuestion("");
            }}
          >
            Clear
          </Button>
        ) : null}
        <Button size="sm" type="submit" disabled={question.trim().length < 3}>
          Ask
        </Button>
      </form>
      <div className="mt-4 mb-4 flex flex-wrap items-center justify-between gap-3">
        <StatusFilter value={tab} onChange={setTab} area="demo-runs" options={TAB_WORDS} />
        <div className="flex flex-wrap gap-2">
          <Select
            aria-label="Agent"
            className="w-auto"
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
          >
            <option value="">Agent: all</option>
            <option value="ucc">UCC filings review</option>
            <option value="invoice">Invoice CRM update</option>
          </Select>
          <Select
            aria-label="Started by"
            className="w-auto"
            value={startedBy}
            onChange={(e) => setStartedBy(e.target.value)}
          >
            <option value="">Started by: any</option>
            <option value="Schedule">Schedule</option>
            <option value="An email">Something happened</option>
            <option value="Mezonas">Mezonas</option>
          </Select>
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-muted">No runs match.</p>
      ) : (
        <div className="dt dt-ana overflow-x-auto">
          <table>
            <thead>
              <tr className="dt-cols">
                {head("run", "Run")}
                {head("agent", "Agent")}
                {head("started", "Started")}
                {head("took", "Took")}
                {head("status", "Status")}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const chip = r.chip(state);
                return (
                  <tr key={r.id} className="demo-rowlink" onClick={() => navigate(r.to)}>
                    <td>
                      <Link
                        to={r.to}
                        className="text-link hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {r.title}
                      </Link>
                      <span className="block font-mono text-xs text-ink-muted">{r.id}</span>
                    </td>
                    <td>{AGENT_NAME[r.agent]}</td>
                    <td className="text-sm">{r.started}</td>
                    <td className="text-sm">{r.took}</td>
                    <td>
                      <StatusChip state={chip.state}>{chip.label}</StatusChip>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}

/** An agent's own runs, for its Runs tab and its overview: the same runs, one agent, newest first. */
export function AgentRunRows({ agent, limit }: { agent: RunEntry["agent"]; limit?: number }) {
  const { state } = useDemo();
  const mine = RUNS.filter((r) => r.agent === agent)
    .sort((a, b) => b.at - a.at)
    .slice(0, limit ?? 100);
  return (
    <>
      {mine.map((r) => {
        const chip = r.chip(state);
        return (
          <RunRow
            key={r.id}
            to={r.to}
            title={`${r.id} · ${r.title}`}
            line={r.took === "–" ? `Started ${r.started}` : `Started ${r.started} · took ${r.took}`}
            chip={<StatusChip state={chip.state}>{chip.label}</StatusChip>}
          />
        );
      })}
      {limit && RUNS.filter((r) => r.agent === agent).length > limit ? (
        <Link to="/runs" className="ops-row ops-row--link text-sm text-link">
          All runs
        </Link>
      ) : null}
    </>
  );
}

// ── A finished run that the demo doesn't tell in full ─────────────────────────────────────────

interface PastStep extends Omit<RunFrameStep, "state"> {
  state?: RunFrameStep["state"];
  facts: [string, string][];
  how: string;
}

interface Past {
  agent: RunEntry["agent"];
  title: string;
  started: string;
  chip: Chip;
  steps: PastStep[];
}

const LONG: Record<string, string> = {
  Mon: "Monday",
  Tue: "Tuesday",
  Wed: "Wednesday",
  Thu: "Thursday",
  Fri: "Friday",
  Oct: "October",
  Nov: "November",
};
/** "Wed Nov 5" → "Wednesday, November 5". */
const longDay = (d: string) => {
  const [w = "", m = "", n = ""] = d.split(" ");
  return `${LONG[w] ?? w}, ${LONG[m] ?? m} ${n}`;
};

function invoicePast(d: (typeof PAST_DAYS)[number]): Past {
  const f = DAYS.find((x) => x.day === d.day);
  const sales = f?.sales ?? 0;
  const rec = f?.reconciled ?? 0;
  const exc = f?.exceptions ?? 0;
  const closed = f?.closed ?? 0;
  const late = d.late;
  return {
    agent: "invoice",
    title: longDay(d.day),
    started: `started 7:00 AM, for the business day before (${d.covers})`,
    chip: DONE,
    steps: [
      {
        key: "collect",
        sop: "1",
        title: "Collect the day's two reports",
        anchor: "collect",
        time: late ? "12:20" : "8:41",
        detail: late
          ? "2 of 2 in · invoice register late, 2 follow-ups"
          : "2 of 2 in · both on time",
        facts: [
          ["Unit sales report", "In at 6:31 AM from Tom Guerra's scheduled export. Checks passed."],
          [
            "Invoice register",
            late
              ? "Due 9:00 AM; followed up at 10:00 AM and noon; in at 12:20 PM from Priya Shah. Checks passed."
              : "In at 8:41 AM from Priya Shah. Checks passed.",
          ],
        ],
        how: "Collect reports · both emailed in · each file checked in code, never by a model.",
      },
      {
        key: "reconcile",
        sop: "2",
        title: "Reconcile sales with Great Plains invoices",
        anchor: "reconcile",
        time: late ? "12:21" : "8:42",
        detail: `${rec} of ${sales} matched · invoice numbers applied`,
        facts: [
          ["Sales", String(sales)],
          ["Reconciled", `${rec}, Great Plains invoice numbers applied`],
          ["Exceptions", String(exc)],
        ],
        how: "Rules first: serial number, then customer and amount. Claude Sonnet 5.5 reads only names written differently.",
      },
      {
        key: "exceptions",
        sop: "3",
        title: "Build the exception report",
        anchor: "exceptions",
        time: late ? "12:21" : "8:42",
        detail: exc === 0 ? "No exceptions" : `${exc} exception${exc === 1 ? "" : "s"}`,
        facts: [["Exceptions", exc === 0 ? "None" : String(exc)]],
        how: "Rules · everything that didn't reconcile.",
      },
      {
        key: "send-exceptions",
        sop: "4",
        title: "Send the exception report to accounting",
        anchor: "send-exceptions",
        time: late ? "12:22" : "8:43",
        detail: exc === 0 ? "Nothing to send" : "To Priya Shah and the accounting team",
        facts: [
          [
            "To",
            exc === 0 ? "Nothing to send" : "Priya Shah; accounting@romco.example; copy Renee Park",
          ],
        ],
        how: "Tells people · an email to ROMCO's own team.",
      },
      {
        key: "match",
        sop: "5.1",
        title: "Match each sale to a Zoho CRM deal",
        anchor: "match",
        time: late ? "12:25" : "8:46",
        detail: `${closed} deals found`,
        facts: [["Deals found", `${closed} for ${rec} sales`]],
        how: "Zoho CRM, read only · account name and address, then the machine.",
      },
      {
        key: "ask",
        sop: "5.2 B1",
        title: "Sales ops finds the deal",
        anchor: "ask",
        time: "",
        detail: "Nothing for sales ops",
        state: "todo",
        facts: [["Sales ops", "Every sale matched a deal; nothing was sent to Tom Guerra."]],
        how: "A person · only when a deal can't be matched.",
      },
      {
        key: "update",
        sop: "6",
        title: "Mark each deal Closed Won and add its invoice number",
        anchor: "update",
        time: late ? "2:40" : "10:05",
        detail: `${closed} deals updated in Zoho CRM`,
        facts: [
          ["Changed", `${closed} deals: Stage, Closing date and Invoice number`],
          ["Signed", "Renee Park"],
        ],
        how: "Zoho CRM · Change, after a person approves · once each, with its before and after kept.",
      },
      {
        key: "summary",
        sop: "7",
        title: "Send the day's summary",
        anchor: "summary",
        time: late ? "2:41" : "10:06",
        detail: "To Renee Park, Priya Shah and Dana Whitfield",
        facts: [["To", "Renee Park; copy Priya Shah, Dana Whitfield"]],
        how: "Tells people.",
      },
    ],
  };
}

const UCC_TEST: Past = {
  agent: "ucc",
  title: "September 2026 UCC file (test run)",
  started: "started Fri Oct 31, 2:10 PM by Mezonas, as a test: nothing is sent or changed",
  chip: { state: "checked", label: "Test run" },
  steps: [
    {
      key: "receive",
      sop: "1",
      title: "Receive the UCC file",
      anchor: "receive",
      time: "2:10",
      detail: "TX_UCC_filings_2026-09.csv · 389 rows",
      facts: [
        ["File", "TX_UCC_filings_2026-09.csv"],
        ["Rows", "389"],
      ],
      how: "Rules · the original is kept with the run.",
    },
    {
      key: "records",
      sop: "2",
      title: "Turn the file into records",
      anchor: "records",
      time: "2:10",
      detail: "389 records · 0 unreadable",
      facts: [
        ["Records", "389"],
        ["Unreadable", "0"],
      ],
      how: "Rules, then Claude Sonnet 5.5 reads the collateral text.",
    },
    {
      key: "verify",
      sop: "3",
      title: "Verify and remove what doesn't apply",
      anchor: "verify",
      time: "2:12",
      detail: "121 kept · 268 removed",
      facts: [
        ["Kept", "121"],
        ["Removed", "268, each with its reason"],
      ],
      how: "Rules first, then Claude Sonnet 5.5.",
    },
    {
      key: "match",
      sop: "4",
      title: "Match each filing",
      anchor: "each",
      time: "2:17",
      detail: "36 on a deal · 47 existing · 38 new",
      facts: [
        ["On a deal", "36 (15 won, 21 lost)"],
        ["Existing client, no deal", "47"],
        ["New to ROMCO", "38"],
      ],
      how: "Deals first, then accounts. Zoho CRM is read only.",
    },
    {
      key: "territory",
      sop: "5",
      title: "Assign a sales manager by ZIP code",
      anchor: "territory",
      time: "2:18",
      detail: "6 sales managers",
      facts: [["Sales managers", "6"]],
      how: "Rules · the Territories by ZIP sheet.",
    },
    {
      key: "forms",
      sop: "6",
      title: "Build the review forms",
      anchor: "forms",
      time: "2:21",
      detail: "6 forms, kept as drafts",
      facts: [["Forms", "6, not sent: a test run never writes"]],
      how: "Rules.",
    },
    {
      key: "send",
      sop: "7",
      title: "Email the forms",
      anchor: "send",
      time: "",
      detail: "Test run: nothing sent",
      state: "todo",
      facts: [["Sent", "Nothing. A test run never emails anyone."]],
      how: "Gmail · Send, after a person approves. Skipped in a test run.",
    },
    {
      key: "answers",
      sop: "8",
      title: "Sales managers complete their forms",
      anchor: "answer",
      time: "",
      detail: "Test run",
      state: "todo",
      facts: [["Forms", "Not sent"]],
      how: "A person.",
    },
    {
      key: "analyse",
      sop: "9",
      title: "Analyse the answers",
      anchor: "analyse",
      time: "",
      detail: "Test run",
      state: "todo",
      facts: [["Analysis", "Not run without answers"]],
      how: "Claude Opus 5.5.",
    },
    {
      key: "report",
      sop: "10",
      title: "Build the dashboard and Excel report",
      anchor: "report",
      time: "",
      detail: "Test run",
      state: "todo",
      facts: [["Report", "Not built"]],
      how: "Rules.",
    },
    {
      key: "email",
      sop: "11",
      title: "Email the report for review",
      anchor: "email",
      time: "",
      detail: "Test run",
      state: "todo",
      facts: [["Sent", "Nothing"]],
      how: "Gmail · Send, after a person approves.",
    },
  ],
};

const PAST: Record<string, Past> = {
  "R-0987": UCC_TEST,
  ...Object.fromEntries(PAST_DAYS.map((d) => [d.id, invoicePast(d)])),
};

export function isPastRun(id: string): boolean {
  return id in PAST;
}

/** A finished run's page: every step with that run's figures. */
export function PastRun() {
  const { run = "", step = "" } = useParams();
  const past = PAST[run];
  if (!past) return null;
  const open = past.steps.find((s) => s.key === step) ?? (past.steps[0] as PastStep);
  return (
    <RunFrame
      agent={{ id: AGENT_ID[past.agent], name: AGENT_NAME[past.agent] }}
      runId={run}
      title={past.title}
      started={past.started}
      chip={past.chip}
      steps={past.steps.map((s) => ({
        key: s.key,
        sop: s.sop,
        title: s.title,
        anchor: s.anchor,
        time: s.time,
        detail: s.detail,
        state: s.state ?? "done",
      }))}
      current={open.key}
      runPath={(k) => `/runs/${run}/${k}`}
      output={
        <>
          <Facts rows={open.facts} />
          <How>{open.how}</How>
          <p className="mt-5 text-sm text-ink-muted">
            <Link to="/runs" className="text-link hover:underline">
              All runs
            </Link>
          </p>
        </>
      }
    />
  );
}
