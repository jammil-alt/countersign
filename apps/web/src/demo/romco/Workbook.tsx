// The Excel report the agent writes (step 10), drawn as a workbook: its sheets as tabs, each a grid
// with column letters and row numbers.
import { useState } from "react";
import { cx } from "../../ui/primitives";
import { BY_REP, FILINGS, GROUP_WORDS, THEMES } from "./filings";
import { REPS, repByKey } from "./people";

type Sheet = { name: string; head: string[]; rows: (string | number)[][]; num: number[] };

const pct = (n: number, d: number) => `${Math.round((n / d) * 100)}%`;

const SHEETS: Sheet[] = [
  {
    name: "Summary",
    head: ["Measure", "October 2026", "Notes"],
    num: [1],
    rows: [
      ["Filings in the file", 412, "Texas, UCC-1 and UCC-3"],
      ["Filings kept", 138, "ROMCO's kind of sale, in its territories"],
      ["On a ROMCO deal", 41, "30% of filings kept"],
      ["Won", 17, "41% of deals; 12% of filings kept"],
      ["Lost", 24, "Price 9, financing 6, availability 5, relationship 4"],
      ["Existing clients, not quoted", 52, "38% of filings kept"],
      ["New to ROMCO", 45, "31 not on anyone's radar"],
      ["Forms answered", "6 of 6", "3 filings moved territory"],
    ],
  },
  {
    name: "By territory",
    head: [
      "Territory",
      "Sales manager",
      "Filings",
      "Won",
      "Lost",
      "Existing, not quoted",
      "New",
      "Share seen",
      "Win rate",
    ],
    num: [2, 3, 4, 5, 6, 7, 8],
    rows: REPS.map((r) => {
      const [w, l, e, n] = BY_REP[r.key] ?? [0, 0, 0, 0];
      const t = w + l + e + n;
      return [r.territory, r.name, t, w, l, e, n, pct(w + l, t), pct(w, w + l)];
    }),
  },
  {
    name: "Filings",
    head: [
      "Filing",
      "Filed",
      "Debtor",
      "City",
      "ZIP",
      "Lender",
      "Equipment",
      "Group",
      "Deal or account",
      "Sales manager",
    ],
    num: [],
    rows: FILINGS.map((f) => [
      f.fileNo,
      f.filed,
      f.debtor,
      f.city,
      f.zip,
      f.securedParty,
      f.equipment,
      GROUP_WORDS[f.group],
      f.deal?.id ?? f.account?.id ?? "",
      repByKey(f.rep).name,
    ]),
  },
  {
    name: "Reasons",
    head: ["Theme", "Filings", "Share", "What it means"],
    num: [1, 2],
    rows: THEMES.map((t) => [t.theme, t.n, `${t.share}%`, t.words]),
  },
];

const COLS = "ABCDEFGHIJKL";

export function Workbook() {
  const [at, setAt] = useState(0);
  const sheet = SHEETS[at] ?? (SHEETS[0] as Sheet);
  return (
    <div className="demo-xl">
      <div className="demo-xl__bar">
        <span className="demo-xl__file">ROMCO UCC review – October 2026.xlsx</span>
        <span className="flex-1" />
        <span className="text-xs text-ink-muted">
          4 sheets · 48 KB · attached to the report email
        </span>
      </div>
      <div className="demo-xl__grid">
        <table>
          <thead>
            <tr>
              <th className="demo-xl__corner" />
              {sheet.head.map((_, i) => (
                <th key={COLS[i]}>{COLS[i]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="demo-xl__head">
              <th>1</th>
              {sheet.head.map((h) => (
                <td key={h}>{h}</td>
              ))}
            </tr>
            {sheet.rows.map((r, i) => (
              <tr key={`${sheet.name}-${String(r[0])}`}>
                <th>{i + 2}</th>
                {r.map((v, j) => (
                  <td key={`${COLS[j]}`} className={cx(sheet.num.includes(j) && "n")}>
                    {v}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="demo-xl__tabs" role="tablist">
        {SHEETS.map((s, i) => (
          <button
            key={s.name}
            type="button"
            role="tab"
            aria-selected={i === at}
            onClick={() => setAt(i)}
          >
            {s.name}
          </button>
        ))}
      </div>
    </div>
  );
}
