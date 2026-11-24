// The demo's state: what has been signed and answered so far, kept for the tab (sessionStorage,
// where it can be), and the tour: the stops a presenter clicks through, in order.
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { RUN_ID, UCC_ID } from "./people";

export interface DemoState {
  /** Dana signed "Send 6 review forms". */
  formsSent: boolean;
  /** Marcus Bell submitted his form (the other five are in already). */
  marcusDone: boolean;
  /** Dana signed "Email the report". */
  reportSent: boolean;
}

const START: DemoState = { formsSent: false, marcusDone: false, reportSent: false };
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

export interface Stop {
  path: string;
  title: string;
  /** What to say or click here. */
  hint: string;
}

export const STOPS: Stop[] = [
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
    path: `${AGENT}/sop#sop-controls`,
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

/**
 * Where the run is at each stop, so Next and Back show the story at that point whether or not the
 * presenter clicked Sign and Send on the way: before the forms go (stops 1 to 12), forms out with
 * Marcus's due (13, 14), all six back (15 to 19), report sent (20).
 */
export function stateAt(stop: number): DemoState {
  const signForms = STOPS.findIndex((s) => s.title.startsWith("7."));
  const form = STOPS.findIndex((s) => s.path === "/f/marcus");
  const sent = STOPS.findIndex((s) => s.path === "/mail/report");
  return {
    formsSent: stop > signForms,
    marcusDone: stop > form,
    reportSent: stop >= sent,
  };
}
