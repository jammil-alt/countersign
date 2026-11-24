// The agent's Report tab for ROMCO: October's UCC review as a dashboard. Where every sale went, by
// territory and by lender, and why ROMCO missed or lost them, with the sources one click away.
import { Link } from "react-router-dom";
import { KpiStrip, StatTile } from "../../ui/figures";
import { Badge, buttonClass, Card } from "../../ui/primitives";
import { BY_REP, THEMES } from "./filings";
import { REPS } from "./people";
import { ShareBar, ShareLegend } from "./RunPage";
import { RUN, useDemo } from "./state";

const LENDERS: [string, number, number][] = [
  // lender, filings, of which ROMCO won
  ["Caterpillar Financial Services Corp", 21, 0],
  ["John Deere Financial", 17, 1],
  ["Wells Fargo Equipment Finance", 15, 4],
  ["Komatsu Financial LP", 13, 0],
  ["Frost Bank", 12, 5],
  ["Kubota Credit Corp USA", 11, 0],
  ["DLL Finance LLC", 10, 4],
  ["Texas Capital Bank", 9, 3],
  ["Other lenders (14)", 30, 0],
];

export function Report() {
  const { state } = useDemo();
  return (
    <div className="flex flex-col gap-6">
      {!state.marcusDone ? (
        <div className="demo-wait">
          <Badge tone="warning">5 of 6 forms back</Badge>
          <p className="text-sm text-ink">
            The reasons fill in when Marcus Bell answers (due Mon Nov 10). The figures from the
            filings are final.
          </p>
          <Link to="/f/marcus" className={buttonClass("secondary")}>
            Open his form
          </Link>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <span className="type-heading">October 2026</span>
        <span className="text-sm text-ink-muted">From {RUN_LABEL} · 138 filings kept of 412</span>
        <span className="flex-1" />
        <Link to={RUN("report")} className={buttonClass("secondary", undefined, "sm")}>
          Excel report
        </Link>
      </div>
      <KpiStrip>
        <StatTile
          label="ROMCO saw"
          value="30%"
          note="41 of 138 sales were on a deal"
          tone="slate"
        />
        <StatTile
          label="ROMCO won"
          value="17"
          note="41% of deals · 12% of all sales"
          tone="positive"
        />
        <StatTile
          label="Existing clients missed"
          value="52"
          note="bought elsewhere, not quoted"
          tone="copper"
        />
        <StatTile label="New buyers" value="45" note="31 weren't on anyone's radar" tone="copper" />
      </KpiStrip>

      <Card titleAbove title="Where every sale went, by territory" meta={<ShareLegend />}>
        <div className="dt dt-ana">
          <div className="dt-scroll">
            <table>
              <thead>
                <tr className="dt-cols">
                  <th>Territory</th>
                  <th className="n">Sales</th>
                  <th style={{ width: "40%" }}>Won · lost · not quoted · new</th>
                  <th className="n">Saw</th>
                  <th className="n">Win rate</th>
                </tr>
              </thead>
              <tbody>
                {REPS.map((r) => {
                  const [w, l, e, n] = BY_REP[r.key] ?? [0, 0, 0, 0];
                  const t = w + l + e + n;
                  return (
                    <tr key={r.key}>
                      <td className="dt-who">
                        <b>{r.territory}</b>
                        <span>{r.name}</span>
                      </td>
                      <td className="n">{t}</td>
                      <td>
                        <ShareBar won={w} lost={l} existing={e} fresh={n} />
                      </td>
                      <td className="n">{Math.round(((w + l) / t) * 100)}%</td>
                      <td className="n">{Math.round((w / (w + l)) * 100)}%</td>
                    </tr>
                  );
                })}
                <tr>
                  <td className="dt-who">
                    <b>All territories</b>
                  </td>
                  <td className="n">
                    <b>138</b>
                  </td>
                  <td>
                    <ShareBar won={17} lost={24} existing={52} fresh={45} />
                  </td>
                  <td className="n">
                    <b>30%</b>
                  </td>
                  <td className="n">
                    <b>41%</b>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </Card>

      <div className="ui-cols ui-cols--2">
        <Card
          titleAbove
          title="Who financed the sales"
          meta={<span className="text-sm text-ink-muted">Filings · won by ROMCO</span>}
        >
          <div className="ui-card__body">
            <ul className="demo-bars">
              {LENDERS.map(([name, n, won]) => (
                <li key={name}>
                  <span className="demo-bars__label">{name}</span>
                  <span className="demo-bars__bar">
                    <span className="demo-share">
                      <i className="is-won" style={{ width: `${(won / 30) * 100}%` }} />
                      <i className="is-missed" style={{ width: `${((n - won) / 30) * 100}%` }} />
                    </span>
                  </span>
                  <span className="figures text-sm">
                    {n}
                    <span className="text-ink-muted"> · {won}</span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-ink-muted">
              A captive lender usually means its own brand's dealer made the sale.
            </p>
          </div>
        </Card>
        <Card
          titleAbove
          title="Why ROMCO missed or lost a sale"
          meta={<span className="text-sm text-ink-muted">From the 6 forms</span>}
        >
          <div className="ui-card__body">
            {state.marcusDone ? (
              <ul className="demo-bars">
                {THEMES.map((t) => (
                  <li key={t.theme}>
                    <span className="demo-bars__label">{t.theme}</span>
                    <span className="demo-bars__bar">
                      <span className="dt-track">
                        <i style={{ width: `${(t.n / 38) * 100}%` }} />
                      </span>
                    </span>
                    <span className="figures text-sm">{t.n}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-muted">Waiting on 1 form.</p>
            )}
          </div>
        </Card>
      </div>

      <Card
        titleAbove
        title="What we'd do next"
        meta={<span className="text-sm text-ink-muted">Proposed by Sol · for Dana Whitfield</span>}
      >
        <ul className="ui-card__body demo-next">
          <li>
            <b>Call the 52 existing clients who weren't quoted.</b> 17 of them bought in Houston
            North and Dallas–Fort Worth; their sales managers named each one on the form.
          </li>
          <li>
            <b>Hand the 45 new buyers to the Invoice CRM update agent as leads.</b> 31 weren't on
            anyone's radar.
          </li>
          <li>
            <b>Look at financing.</b> 6 of the 24 lost deals went on rate or terms, 4 of them in San
            Antonio and South Texas.
          </li>
        </ul>
      </Card>
      <p className="text-xs text-ink-muted">
        Every figure links to its filings in run {RUN_LABEL}. Sources: the October Texas UCC file,
        ROMCO CRM (read only), Territories by ZIP, and the six sales managers' forms.
      </p>
    </div>
  );
}

const RUN_LABEL = "R-1042";
