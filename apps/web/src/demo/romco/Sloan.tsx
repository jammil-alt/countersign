// Sloan, ROMCO's account agent, as the portal draws it (portal/screens/Sloan.tsx and
// portal/SloanPanel.tsx): the full page with its conversation and rail, and the side panel the top
// bar's Ask Sloan opens over any page. Both are the same parts as the real ones (ChatLog, YouSaid,
// AgentSaid, Thinking, Composer, SideSheet); the conversation is kept here, and Sloan's answers
// are written for the demo from where the two agents' runs are.
import { AREA_OWNER_WORDS } from "@countersign/core";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ActivityRow } from "../../ui/activity";
import { type AttachedFile, MessageFiles } from "../../ui/attach";
import { AgentBadge, PersonBadge } from "../../ui/badges";
import { AgentSaid, ChatLog, Composer, Thinking, YouSaid } from "../../ui/chat";
import { Select } from "../../ui/forms";
import { Icon } from "../../ui/icons";
import { Page, PageGrid, Section } from "../../ui/page";
import { Button, buttonClass, Card, cx, PageHeader, Tabs } from "../../ui/primitives";
import { SideSheet } from "../../ui/sheet";
import { StatusChip } from "../../ui/status";
import { runChip } from "./AgentPage";
import { invoiceChip } from "./invoice/InvoicePage";
import { INVOICE_ID, UCC_ID } from "./people";
import { AGENT, type DemoState, INV_AGENT, INV_RUN, useDemo } from "./state";

interface Said {
  id: string;
  you: boolean;
  text: string;
  at: string;
  /** Who answered, when it isn't Sloan: one of the client's agents, asked with /name. */
  from?: { name: string; role: string; seed: string };
  files?: AttachedFile[];
  links?: { label: string; to: string }[];
}

const WORDS = AREA_OWNER_WORDS.en;

const HISTORY: Said[] = [
  {
    id: "h1",
    you: true,
    text: "When does the UCC file come in each month?",
    at: "Mon Nov 3, 8:40 AM",
  },
  {
    id: "h2",
    you: false,
    text: "The Texas UCC file comes by email on the first business day of each month, to ucc@romco.in.mezonas.com. The UCC filings review starts as soon as it's in.\n\nOctober's came in today at 8:02 AM. It's run R-1042: 412 filings read, 138 kept.",
    at: "Mon Nov 3, 8:40 AM",
    links: [{ label: "Open run R-1042", to: "/runs/R-1042/receive" }],
  },
];

const STARTERS = [
  "What did my agents do today?",
  "What's waiting on me, and why?",
  "I have an idea for a new agent.",
];

const CAN: [string, boolean][] = [
  ["See every agent's work, runs and receipts", true],
  ["Pause or resume an agent, right away", true],
  ["Draft changes to people and approvers for you to approve", true],
  ["Pass requests and new agent ideas to your lead", true],
  ["Never loosens a rule or sees your vault", false],
];

/** Sloan's answer to `text`, from where the runs are now. */
function answer(text: string, s: DemoState): Omit<Said, "id" | "at" | "you"> {
  const q = text.toLowerCase();
  const ucc = { name: "UCC filings review", role: "sales agent", seed: UCC_ID };
  const inv = { name: "Invoice CRM update", role: "sales agent", seed: INVOICE_ID };
  if (q.startsWith("/ucc")) {
    return {
      from: ucc,
      text: s.marcusDone
        ? "All six forms are back for October. ROMCO saw 41 of 138 equipment sales (30%) and won 17. 52 existing clients bought without a quote; the top reason is that we didn't know they were buying."
        : "October's filings are matched: 41 on a deal (17 won, 24 lost), 52 existing clients not quoted, 45 new to ROMCO. I'm waiting on the sales managers' forms before the report.",
      links: [{ label: "Open the report", to: `${AGENT}/report` }],
    };
  }
  if (q.startsWith("/invoice")) {
    return {
      from: inv,
      text:
        s.inv === 0
          ? "Today's unit sales report came in at 6:32 AM. The Great Plains invoice register was due at 9:00 AM and isn't in; I followed up with Priya Shah at 10:00 AM."
          : s.inv === 3
            ? "Yesterday's sales are done: 7 of 9 reconciled, 4 exceptions sent to accounting, and 6 deals marked Closed Won in Zoho CRM with their invoice numbers."
            : "Both reports are in and reconciled: 7 of 9 sales matched their Great Plains invoices. 6 of 7 matched a Zoho deal; 1 is with Tom Guerra.",
      links: [{ label: "Open today's run", to: INV_RUN("collect") }],
    };
  }
  if (q.includes("today") || q.includes("my agents do")) {
    const uccLine = !s.formsSent
      ? "UCC filings review: October's file is read and matched; 6 review forms wait on your sign-off."
      : !s.marcusDone
        ? "UCC filings review: the 6 review forms went out; 5 are back, Marcus Bell's is due Monday."
        : s.reportSent
          ? "UCC filings review: October's report went to you and the regional managers."
          : "UCC filings review: all 6 forms are back; the report waits on your sign-off.";
    const invLine =
      s.inv === 0
        ? "Invoice CRM update: the unit sales report is in; the invoice register is late and Priya Shah was followed up at 10:00 AM."
        : s.inv === 1
          ? "Invoice CRM update: both reports reconciled (7 of 9 sales), 4 exceptions sent to accounting, 1 sale with Tom Guerra to find its deal."
          : s.inv === 2
            ? "Invoice CRM update: 6 Zoho deals are ready to mark Closed Won; they wait on Renee Park's sign-off."
            : "Invoice CRM update: 6 deals marked Closed Won in Zoho CRM with their invoice numbers.";
    return {
      text: `Here's today:\n\n- ${uccLine}\n- ${invLine}`,
      links: [
        { label: "UCC filings review", to: AGENT },
        { label: "Invoice CRM update", to: INV_AGENT },
      ],
    };
  }
  if (q.includes("waiting")) {
    const items: string[] = [];
    if (!s.formsSent)
      items.push(
        "Sign: send 6 UCC review forms to the sales managers. Nothing is emailed until you sign.",
      );
    if (s.marcusDone && !s.reportSent) items.push("Sign: email October's UCC report for review.");
    if (s.inv === 2)
      items.push("Sign (Renee Park): mark 6 Zoho deals Closed Won with their invoice numbers.");
    const others: string[] = [];
    if (s.formsSent && !s.marcusDone) others.push("Marcus Bell's UCC review form, due Monday.");
    if (s.inv === 0)
      others.push("Priya Shah's invoice register, due at 9:00 AM; followed up at 10:00 AM.");
    if (s.inv === 1) others.push("Tom Guerra, to find the Zoho deal for 1 sale by 3:00 PM.");
    const mine = items.length
      ? items.map((i) => `- ${i}`).join("\n")
      : "Nothing waits on you right now.";
    const theirs = others.length
      ? `\n\nWaiting on others:\n\n${others.map((i) => `- ${i}`).join("\n")}`
      : "";
    return {
      text: `${items.length ? "Waiting on you:\n\n" : ""}${mine}${theirs}`,
      links: items.length ? [{ label: "Open the Inbox", to: "/inbox" }] : [],
    };
  }
  if (q.includes("idea") || q.includes("new agent")) {
    return {
      text: "Good. Tell me what it should do, what it starts from (a file, an email, a schedule), and who signs off on what it changes. I'll write it up and pass it to Ana Torres, your lead. Nothing is built until you agree to it.",
    };
  }
  if (q.includes("pause")) {
    return {
      text: "I can pause an agent right away; it finishes nothing new until you resume it, and anything that comes in meanwhile is kept. Which one: the UCC filings review or the Invoice CRM update?",
    };
  }
  if (q.startsWith("about the")) {
    return {
      text: "That's a line of the agent's SOP. It's made from how the agent is set up now, so it says what the agent actually does.\n\nIf it should say something else, tell me what, or use \"This is wrong\" on the line. I'll pass it to Ana Torres; a change to how the agent works becomes a new SOP revision, and you see what changed.",
    };
  }
  if (
    q.includes("zoho") ||
    q.includes("invoice") ||
    q.includes("great plains") ||
    q.includes("priya")
  ) {
    return {
      from: inv,
      text: "The invoice register and the unit sales report are emailed in every business day by 9:00 AM. I reconcile them, apply the Great Plains invoice numbers, send accounting the exceptions, and mark each deal Closed Won in Zoho CRM after Renee Park signs. I can only change Stage, Closing date and Invoice number, and I never create or delete anything.",
      links: [{ label: "Open the Invoice CRM update", to: INV_AGENT }],
    };
  }
  if (q.includes("ucc") || q.includes("filing")) {
    return {
      from: ucc,
      text: "I read each month's Texas UCC filings, keep the equipment sales in ROMCO's territories, match them to Zoho deals and accounts, and ask each sales manager about the ones ROMCO missed. Zoho CRM is read only for me, and nothing is emailed without Dana Whitfield's sign-off.",
      links: [{ label: "Open the UCC filings review", to: AGENT }],
    };
  }
  return {
    text: "I can see every agent's work, runs and receipts, pause or resume an agent, draft changes to people and approvers for you to approve, and pass requests to Ana Torres, your lead. I never loosen a rule.\n\nTry asking what's waiting on you, or start with /ucc or /invoice to ask one of your agents.",
  };
}

interface SloanApi {
  said: Said[];
  thinking: boolean;
  send: (text: string, files: AttachedFile[]) => void;
  fresh: () => void;
  panel: { open: boolean; prefill: string; key: number };
  openPanel: (prefill?: string) => void;
  closePanel: () => void;
}

const Ctx = createContext<SloanApi | null>(null);

const now = () => new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

export function SloanProvider({ children }: { children: ReactNode }) {
  const { state } = useDemo();
  const [said, setSaid] = useState<Said[]>(HISTORY);
  const [thinking, setThinking] = useState(false);
  const [panel, setPanel] = useState({ open: false, prefill: "", key: 0 });
  const live = useRef(state);
  live.current = state;
  const n = useRef(0);
  const send = useCallback((text: string, files: AttachedFile[]) => {
    const id = `m${++n.current}`;
    setSaid((all) => [...all, { id, you: true, text, at: now(), files }]);
    setThinking(true);
    window.setTimeout(
      () => {
        setSaid((all) => [
          ...all,
          { id: `${id}-a`, you: false, at: now(), ...answer(text, live.current) },
        ]);
        setThinking(false);
      },
      1400 + Math.min(text.length * 10, 900),
    );
  }, []);
  const api = useMemo<SloanApi>(
    () => ({
      said,
      thinking,
      send,
      fresh: () => setSaid([]),
      panel,
      openPanel: (prefill = "") => setPanel((p) => ({ open: true, prefill, key: p.key + 1 })),
      closePanel: () => setPanel((p) => ({ ...p, open: false })),
    }),
    [said, thinking, send, panel],
  );
  return (
    <Ctx.Provider value={api}>
      {children}
      {panel.open ? <SloanPanel key={panel.key} /> : null}
    </Ctx.Provider>
  );
}

export function useSloan(): SloanApi {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSloan outside SloanProvider");
  return s;
}

/** The conversation: in a card on the page, or bare in the side panel with the box at its foot. */
function Conversation({ bare, prefill }: { bare?: boolean; prefill?: string }) {
  const { said, thinking, send } = useSloan();
  const [params] = useSearchParams();
  const [text, setText] = useState(() => prefill || (params.get("ask") ?? ""));
  const body = (
    <div className={cx("flex flex-col gap-6", !bare && "ui-card__body", bare && "flex-1")}>
      {said.length === 0 && !thinking ? (
        <p className="text-ink-muted">
          Ask why something waits, pause an agent, add an approver, or pass an idea to your lead.
        </p>
      ) : (
        <ChatLog roomy follow={`${said.length}:${thinking}`}>
          {said.map((m) => (
            <Message key={m.id} m={m} />
          ))}
          {thinking ? (
            <Thinking
              badge={<AgentBadge name="Sloan" size="sm" />}
              label="Sloan is answering…"
              state="drafting"
            />
          ) : null}
        </ChatLog>
      )}
    </div>
  );
  const composer = (
    <div
      className={cx(
        "ui-composer",
        bare ? "sticky bottom-0 flex flex-col gap-2 bg-surface pt-3" : "ui-card__foot",
      )}
    >
      <Composer
        label="Ask Sloan, or tell it what to change"
        placeholder="Ask Sloan, or tell it what to change"
        busy={thinking}
        value={text}
        onValueChange={setText}
        onSend={(words, files) => {
          send(words, files);
          return true;
        }}
        attach={{
          upload: async (picked) => ({
            files: picked.map((f, i) => ({
              id: `f-${Date.now()}-${i}`,
              name: f.name,
              contentType: f.type || "application/octet-stream",
            })),
            refused: [],
          }),
        }}
        above={
          <div className="flex flex-wrap gap-1.5">
            {STARTERS.map((k) => (
              <button
                key={k}
                type="button"
                className="ds-tag hover:border-line-strong"
                onClick={() => setText(k)}
              >
                {k}
              </button>
            ))}
          </div>
        }
      />
      <p className="text-sm text-ink-muted">
        Start with / and an agent's name to ask that agent, like /ucc or /invoice.
      </p>
    </div>
  );
  if (bare) {
    return (
      <div className="flex min-h-full flex-col gap-4">
        {body}
        {composer}
      </div>
    );
  }
  return (
    <Card>
      {body}
      {composer}
    </Card>
  );
}

function Message({ m }: { m: Said }) {
  const { closePanel } = useSloan();
  if (m.you) {
    return (
      <div className="flex flex-col items-end gap-1">
        <YouSaid text={m.text} above={`You · ${m.at}`} mono={m.text.startsWith("/")} />
        <MessageFiles files={m.files ?? []} />
      </div>
    );
  }
  const name = m.from?.name ?? "Sloan";
  const role = m.from?.role ?? WORDS.assistant;
  return (
    <AgentSaid
      badge={<AgentBadge name={name} seed={m.from?.seed} size="sm" />}
      above={`${name} · ${role} · ${m.at}`}
      text={m.text}
    >
      {m.links && m.links.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {m.links.map((l) => (
            <Link
              key={l.to}
              to={l.to}
              className={buttonClass("secondary", undefined, "sm")}
              onClick={closePanel}
            >
              {l.label}
            </Link>
          ))}
        </div>
      ) : null}
    </AgentSaid>
  );
}

/** The side panel the top bar's Ask Sloan opens over the page you're on. */
function SloanPanel() {
  const { panel, closePanel, fresh, said } = useSloan();
  return (
    <SideSheet
      wide
      title="Sloan"
      eyebrow={
        <span className="flex items-center gap-2">
          <AgentBadge name="Sloan" size="sm" />
          <span className="text-sm text-ink-muted">
            {WORDS.assistant} · {WORDS.agentNote}
          </span>
        </span>
      }
      onClose={closePanel}
      tabs={
        <div className="flex flex-wrap items-center gap-2 px-6 pb-3">
          <Select aria-label="Past conversations" className="w-auto" defaultValue="now">
            <option value="now">{said.length ? "Sloan · Nov 3" : "New conversation"}</option>
          </Select>
          <Button size="sm" onClick={fresh}>
            New conversation
          </Button>
          <Link to="/sloan" className="text-sm" onClick={closePanel}>
            Full history
          </Link>
        </div>
      }
    >
      <Conversation bare prefill={panel.prefill} />
    </SideSheet>
  );
}

/** The full page, `/sloan`: the conversation and the rail; `/sloan/change` holds requests to us. */
export function SloanPage({ change }: { change?: boolean }) {
  const { fresh } = useSloan();
  return (
    <Page>
      <PageHeader
        leading={<AgentBadge name="Sloan" size="lg" />}
        title="Sloan"
        subtitle="Manages your agents and your account. Your admins and your Mezonas lead can read this conversation."
        actions={
          change ? null : (
            <>
              <Select aria-label="Past conversations" className="w-auto" defaultValue="nov3">
                <option value="nov3">Started Nov 3</option>
                <option value="oct29">Started Oct 29</option>
              </Select>
              <Button onClick={fresh}>New</Button>
            </>
          )
        }
      />
      <Tabs
        items={[
          { to: "/sloan", label: "Ask Sloan", end: true, active: !change },
          { to: "/sloan/change", label: "Ask for a change", active: !!change },
        ]}
      />
      <div className="mt-5">
        {change ? (
          <Requests />
        ) : (
          <PageGrid rail={<Rail />}>
            <Conversation />
          </PageGrid>
        )}
      </div>
    </Page>
  );
}

function Rail() {
  const { state } = useDemo();
  const ucc = runChip(state);
  const inv = invoiceChip(state.inv);
  return (
    <>
      <Section
        title="Sloan can"
        action={
          <Link to="/sloan/change" className="text-sm text-link hover:underline">
            Your requests to us
          </Link>
        }
      >
        <Card>
          {CAN.map(([k, yes]) => (
            <ActivityRow
              key={k}
              badge={<Icon name={yes ? "check" : "close"} className="text-ink-muted" />}
            >
              <span className={yes ? "text-sm" : "text-sm text-ink-muted"}>{k}</span>
            </ActivityRow>
          ))}
        </Card>
      </Section>
      <Section title="Email or text Sloan">
        <Card>
          <ActivityRow badge={<Icon name="email" className="text-ink-muted" />}>
            <span className="text-sm">
              Email <span className="text-link break-all">sloan@romco.in.mezonas.com</span>
            </span>
          </ActivityRow>
          <p className="px-4 pb-3 text-sm text-ink-muted">
            From an address or number we know is yours; Sloan answers the same way.
          </p>
        </Card>
      </Section>
      <Section title="Your team right now">
        <Card>
          <ActivityRow
            badge={<AgentBadge name="UCC filings review" seed={UCC_ID} size="sm" />}
            to={AGENT}
            end={<StatusChip state={ucc.state}>{ucc.label}</StatusChip>}
          >
            UCC filings review
          </ActivityRow>
          <ActivityRow
            badge={<AgentBadge name="Invoice CRM update" seed={INVOICE_ID} size="sm" />}
            to={INV_AGENT}
            end={<StatusChip state={inv.state}>{inv.label}</StatusChip>}
          >
            Invoice CRM update
          </ActivityRow>
        </Card>
      </Section>
      <div className="ui-leadnote">
        <PersonBadge name="Ana Torres" line="Your Mezonas lead" size="sm" />
        <p className="text-sm">
          Sloan handles the quick things. For anything bigger, Ana Torres is here.
        </p>
      </div>
    </>
  );
}

function Requests() {
  const rows = [
    {
      n: "#214",
      what: 'UCC filings review, step 4.1: "A deal counts if it closed in the 120 days before the filing"',
      why: "Use 180 days for cranes; their deals run longer.",
      status: <StatusChip state="running">With Ana Torres</StatusChip>,
    },
    {
      n: "#209",
      what: "Invoice CRM update: copy Kelsey Tran on exceptions for the Beaumont branch",
      why: "She follows up on Beaumont deliveries.",
      status: <StatusChip state="done">Done · SOP 0.1 → 0.2</StatusChip>,
    },
  ];
  return (
    <Card
      titleAbove
      title="Your requests to us"
      meta={<span className="text-sm text-ink-muted">From "This is wrong" and Sloan</span>}
    >
      {rows.map((r) => (
        <div key={r.n} className="ops-row">
          <span className="ops-row__text">
            <span className="block text-ink">
              <span className="font-mono text-xs text-ink-muted">{r.n}</span> {r.what}
            </span>
            <span className="block text-sm text-ink-muted">{r.why}</span>
          </span>
          <span className="ops-row__end">{r.status}</span>
        </div>
      ))}
    </Card>
  );
}
