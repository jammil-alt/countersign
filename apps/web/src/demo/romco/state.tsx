// The demo's state: what has been signed and answered so far, kept for the tab (sessionStorage,
// where it can be), and the tours: the stops a presenter clicks through, one tour per agent, in
// order (the UCC filings review, then the Invoice CRM update).
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { INVOICE_ID, INVOICE_RUN_ID, RUN_ID, UCC_ID } from "./people";

export interface DemoState {
  /** Dana signed "Send 6 review forms". */
  formsSent: boolean;
  /** Marcus Bell submitted his form (the other five are in already). */
  marcusDone: boolean;
  /** Dana signed "Email the report". */
  reportSent: boolean;
  /**
   * The Invoice CRM update's run: 0 waiting on the invoice register (1 of 2 reports in), 1 both in
   * and reconciled, waiting on sales ops for the deals not found, 2 waiting on Renee to sign the
   * Zoho updates, 3 done.
   */
  inv: 0 | 1 | 2 | 3;
}

const START: DemoState = { formsSent: false, marcusDone: false, reportSent: false, inv: 0 };
const KEY = "mezonas-demo-romco-ucc";

function load(): DemoState {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? { ...START, ...(JSON.parse(raw) as Partial<DemoState>) } : START;
  } catch {
    return START;
  }
}

interface DemoContext {
  state: DemoState;
  set: (patch: Partial<DemoState>) => void;
  reset: () => void;
}

const Ctx = createContext<DemoContext>({ state: START, set: () => {}, reset: () => {} });

export function DemoProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DemoState>(load);
  const save = useCallback((next: DemoState) => {
    setState(next);
    try {
      sessionStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // Storage closed (a private window): the demo still works for this page load.
    }
  }, []);
  const value = useMemo(
    () => ({
      state,
      set: (patch: Partial<DemoState>) => save({ ...state, ...patch }),
      reset: () => save(START),
    }),
    [state, save],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useDemo = () => useContext(Ctx);

export const AGENT = `/agents/${UCC_ID}`;
export const RUN = (step: string) => `/runs/${RUN_ID}/${step}`;
export const INV_AGENT = `/agents/${INVOICE_ID}`;
export const INV_RUN = (step: string) => `/runs/${INVOICE_RUN_ID}/${step}`;

export interface Stop {
  path: string;
  title: string;
  /** What to say or click here. */
  hint: string;
}

export const UCC_STOPS: Stop[] = [
  {
    path: AGENT,
    title: "The agent",
    hint: "ROMCO's UCC filings review: this month's figures, its runs and what waits on you.",
  },
  {
    path: `${AGENT}/flow`,
    title: "Workflow",
    hint: "The process as the builder draws it. Click a box to see who does it and how.",
  },
  {
    path: `${AGENT}/sop`,
    title: "SOP",
    hint: "The formal procedure, made from how the agent is set up. Click a person or system to filter.",
  },
  {
    path: `${AGENT}/sop#sop-sec-controls`,
    title: "Controls",
    hint: "What prevents and what catches a mistake, who owns it and the evidence.",
  },
  {
    path: `${AGENT}/settings`,
    title: "Access",
    hint: "What it may do in each of ROMCO's tools. Zoho CRM is read only; Gmail asks first.",
  },
  {
    path: RUN("receive"),
    title: "1. The raw file",
    hint: "October's UCC file arrives by email: 412 rows, as the state publishes them.",
  },
  {
    path: RUN("records"),
    title: "2. Records (JSON)",
    hint: "Each row becomes a record; AI reads the equipment out of the collateral text.",
  },
  {
    path: RUN("verify"),
    title: "3. Verification",
    hint: "Rules first, AI second: 274 filings removed, each with its reason. 138 kept.",
  },
  {
    path: RUN("match"),
    title: "4. Matching",
    hint: "Deals first (won or lost), then existing accounts, and the rest are new to ROMCO.",
  },
  {
    path: RUN("territory"),
    title: "5. Territories",
    hint: "Each filing goes to a sales manager by the debtor's ZIP code.",
  },
  {
    path: RUN("forms"),
    title: "6. Review forms",
    hint: "One form per sales manager. Preview Marcus Bell's before it goes.",
  },
  {
    path: "/inbox",
    title: "7. Sign to send",
    hint: "Nothing is emailed until Dana signs. Click Sign.",
  },
  { path: "/mail/form", title: "8. The email", hint: "What Marcus Bell and his manager receive." },
  {
    path: "/f/marcus",
    title: "9. The sales manager's form",
    hint: "Confirm, explain, and say what was on the radar. Fill example answers, then Submit.",
  },
  {
    path: RUN("answers"),
    title: "10. Answers back",
    hint: "Six of six forms back, with what each sales manager changed.",
  },
  {
    path: RUN("analyse"),
    title: "11. Analysis",
    hint: "The share ROMCO saw and won, and the reasons grouped into themes.",
  },
  {
    path: `${AGENT}/report`,
    title: "12. Dashboard",
    hint: "The Report tab: by territory, by lender, and why sales were missed.",
  },
  {
    path: RUN("report"),
    title: "13. Excel report",
    hint: "The workbook the agent writes: summary, territories, filings, reasons. Click the sheet tabs.",
  },
  {
    path: "/inbox",
    title: "14. Sign the report",
    hint: "The report goes by email only after Dana signs. Click Sign.",
  },
  {
    path: "/mail/report",
    title: "15. Sent for review",
    hint: "The report email to Dana and the regional managers. End of the run.",
  },
];

const UCC_SIGN = 11;
const UCC_FORM = 13;
const UCC_SENT = 19;

export const INVOICE_STOPS: Stop[] = [
  {
    path: INV_AGENT,
    title: "The agent",
    hint: "Invoice CRM update: each month it waits for two reports, then closes the deals in Zoho CRM.",
  },
  {
    path: `${INV_AGENT}/flow`,
    title: "Workflow",
    hint: "It starts by collecting two reports, each from its owner. Click the first box for who and when.",
  },
  {
    path: `${INV_AGENT}/sop`,
    title: "SOP",
    hint: "The procedure, with who sends each report, the follow-ups and who it escalates to.",
  },
  {
    path: `${INV_AGENT}/settings`,
    title: "Access",
    hint: "Zoho CRM: read on its own, changes only after sign-off, never creates or deletes.",
  },
  {
    path: INV_RUN("collect"),
    title: "1. Waiting for both reports",
    hint: "The unit sales report is in; the Great Plains invoice register is a day late and followed up.",
  },
  {
    path: "/mail/followup",
    title: "2. The follow-up",
    hint: "What Priya Shah gets the morning after her report was due.",
  },
  {
    path: "/r/register",
    title: "3. Priya sends the file",
    hint: "Her link checks the file in code before it's taken. Use the example file, then Send.",
  },
  {
    path: INV_RUN("reconcile"),
    title: "4. Reconcile",
    hint: "Both reports in: each sale matched to its Great Plains invoice, and the invoice number applied.",
  },
  {
    path: INV_RUN("exceptions"),
    title: "5. Exception report",
    hint: "What didn't reconcile, in three groups, for the accounting team.",
  },
  {
    path: "/mail/exceptions",
    title: "6. Sent to accounting",
    hint: "The exception report goes to Priya Shah and the accounting team.",
  },
  {
    path: INV_RUN("match"),
    title: "7. Match to Zoho deals",
    hint: "Each invoiced sale matched to its Zoho deal by account name and address, then the equipment.",
  },
  {
    path: "/mail/deals",
    title: "8. Help with the rest",
    hint: "The 8 sales it couldn't match go to sales ops by email.",
  },
  {
    path: "/f/deals",
    title: "9. Sales ops finds the deals",
    hint: "Pick the right deal, or say there isn't one. Fill example answers, then Send.",
  },
  {
    path: "/inbox",
    title: "10. Sign the Zoho updates",
    hint: "Nothing changes in Zoho until Renee Park signs. Click Sign.",
  },
  {
    path: INV_RUN("update"),
    title: "11. Zoho updated",
    hint: "95 deals marked Closed Won, each with its Great Plains invoice number.",
  },
  {
    path: `${INV_AGENT}/report`,
    title: "12. Report",
    hint: "The month at a glance: reports, reconciliation, exceptions and deals closed.",
  },
  {
    path: "/mail/summary",
    title: "13. The month's summary",
    hint: "The summary email to Renee, Priya and Dana. End of the run.",
  },
];

const INV_UPLOAD = 6;
const INV_FORM = 12;
const INV_SIGN = 13;

export interface Tour {
  key: "ucc" | "invoice";
  name: string;
  stops: Stop[];
  /**
   * Where the run is at each stop, so Next and Back show the story at that point whether or not
   * the presenter clicked Sign and Send on the way. Only the tour's own part of the state.
   */
  stateAt: (stop: number) => Partial<DemoState>;
}

export const TOURS: Tour[] = [
  {
    key: "ucc",
    name: "UCC filings review",
    stops: UCC_STOPS,
    // Before the forms go (stops 1 to 12), forms out with Marcus's due (13, 14), all six back
    // (15 to 19), report sent (20).
    stateAt: (i) => ({
      formsSent: i > UCC_SIGN,
      marcusDone: i > UCC_FORM,
      reportSent: i >= UCC_SENT,
    }),
  },
  {
    key: "invoice",
    name: "Invoice CRM update",
    stops: INVOICE_STOPS,
    // Waiting on the register (1 to 7), reconciled and waiting on sales ops (8 to 13), waiting on
    // Renee's sign-off (14), done (15 to 17).
    stateAt: (i) => ({ inv: i <= INV_UPLOAD ? 0 : i <= INV_FORM ? 1 : i <= INV_SIGN ? 2 : 3 }),
  },
];
