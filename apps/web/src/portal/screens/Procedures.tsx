// The portal's Procedures page (docs/sop-plan.md §6, S2 "Across agents"): every agent's SOP the
// reader can open, in a row each, with its stage, revision, revision date and what changed last,
// and the same filters across all of them ("which agents change QuickBooks?", "where does Ben take
// part?"). Each row opens the agent's SOP tab. It reads the portal's own list (`GET /api/sops`),
// made by code from each agent's SOP: never the bundle, instructions, prompts or cost
// (invariant 11). A limited client user sees only their own agents, as everywhere in the portal.
// Loaded when opened, so the first load stays in its budget.

import { type SopList, type SopListItem, sopMayChange, sopRoutes } from "@countersign/core";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useApi } from "../../api/useApi";
import { useI18n } from "../../i18n/i18n";
import { Select, TextInput } from "../../ui/forms";
import { Loaded, Page } from "../../ui/page";
import { Button, Card, cx, PageHeader } from "../../ui/primitives";
import { SkeletonRows } from "../../ui/skeleton";
import { PORTAL_PATHS } from "../paths";

type Does = "" | "changes" | "reads";

export function ProceduresScreen() {
  const { t } = useI18n();
  const list = useApi(sopRoutes.portalSops);
  return (
    <Page testId="portal-procedures">
      <PageHeader title={t("procedures.title")} subtitle={t("procedures.subtitle")} />
      <Loaded state={list} skeleton={<SkeletonRows rows={5} columns={5} />}>
        {(data) => <ProcedureList data={data} />}
      </Loaded>
    </Page>
  );
}

/** Whether a row passes the filters: words anywhere in it, a system and what it does there, a person. */
export function matches(
  row: SopListItem,
  f: { text: string; system: string; does: Does; party: string },
  pausedWord = "Paused",
): boolean {
  if (f.system) {
    const s = row.systems.find((x) => x.key === f.system);
    if (!s) return false;
    if (f.does === "changes" && !sopMayChange(s)) return false;
    if (f.does === "reads" && !(s.read === "auto" || s.read === "ask")) return false;
  } else if (f.does === "changes" && !row.systems.some(sopMayChange)) {
    return false;
  }
  if (f.party && !row.parties.some((p) => p.key === f.party)) return false;
  const q = f.text.trim().toLowerCase();
  if (!q) return true;
  const words = [
    row.agent.name,
    row.code,
    row.area.words,
    row.stage.words,
    ...(row.paused ? [pausedWord] : []),
    row.purpose,
    ...row.systems.map((s) => s.name),
    ...row.parties.map((p) => p.name),
    ...(row.revision?.changes.map((c) => c.words) ?? []),
  ];
  return words.some((w) => w.toLowerCase().includes(q));
}

function ProcedureList({ data }: { data: SopList }) {
  const { t, fmt } = useI18n();
  const [text, setText] = useState("");
  const [system, setSystem] = useState("");
  const [does, setDoes] = useState<Does>("");
  const [party, setParty] = useState("");
  const systems = useMemo(() => {
    const out = new Map<string, string>();
    for (const r of data.sops) for (const s of r.systems) out.set(s.key, s.name);
    return [...out].sort((a, b) => a[1].localeCompare(b[1]));
  }, [data]);
  const parties = useMemo(() => {
    const out = new Map<string, string>();
    for (const r of data.sops) for (const p of r.parties) out.set(p.key, p.name);
    return [...out].sort((a, b) => a[1].localeCompare(b[1]));
  }, [data]);
  const rows = data.sops.filter((r) =>
    matches(r, { text, system, does, party }, t("state.agent.paused")),
  );
  const filtered = !!(text.trim() || system || does || party);

  if (data.sops.length === 0) {
    return (
      <p className="text-sm text-ink-muted" data-testid="procedures-none">
        {t("procedures.none")}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2" data-testid="procedures-filters">
        <TextInput
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("procedures.find")}
          aria-label={t("procedures.find")}
          className="min-w-0 flex-1"
          data-testid="procedures-find"
        />
        <Select
          value={system}
          onChange={(e) => setSystem(e.target.value)}
          aria-label={t("procedures.system")}
          className="w-56"
          data-testid="procedures-system"
        >
          <option value="">{t("procedures.anySystem")}</option>
          {systems.map(([key, name]) => (
            <option key={key} value={key}>
              {name}
            </option>
          ))}
        </Select>
        <Select
          value={does}
          onChange={(e) => setDoes(e.target.value as Does)}
          aria-label={t("procedures.does")}
          className="w-48"
          data-testid="procedures-does"
        >
          <option value="">{t("procedures.does.any")}</option>
          <option value="changes">{t("procedures.does.changes")}</option>
          <option value="reads">{t("procedures.does.reads")}</option>
        </Select>
        <Select
          value={party}
          onChange={(e) => setParty(e.target.value)}
          aria-label={t("procedures.party")}
          className="w-48"
          data-testid="procedures-party"
        >
          <option value="">{t("procedures.anyone")}</option>
          {parties.map(([key, name]) => (
            <option key={key} value={key}>
              {name}
            </option>
          ))}
        </Select>
        {filtered ? (
          <Button
            size="sm"
            variant="ghost"
            data-testid="procedures-clear"
            onClick={() => {
              setText("");
              setSystem("");
              setDoes("");
              setParty("");
            }}
          >
            {t("sop.showAll")}
          </Button>
        ) : null}
      </div>
      <p className="text-sm text-ink-muted" data-testid="procedures-count">
        {t("procedures.count", { shown: rows.length, total: data.sops.length })}
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-muted">{t("procedures.noMatch")}</p>
      ) : (
        <Card>
          <div className="dt dt-ana overflow-x-auto">
            <table data-testid="procedures-table">
              <thead>
                <tr className="dt-cols">
                  <th>{t("procedures.col.agent")}</th>
                  <th>{t("sop.stage")}</th>
                  <th>{t("sop.revision")}</th>
                  <th>{t("procedures.col.changed")}</th>
                  <th>{t("sop.sec.systems")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.agent.id} data-testid={`procedures-row-${r.agent.id}`}>
                    <td>
                      <Link
                        to={PORTAL_PATHS.agentSop(r.agent.id)}
                        className="ds-btn ds-btn--link"
                        data-testid={`procedures-open-${r.agent.id}`}
                      >
                        {r.agent.name}
                      </Link>
                      <span className="block font-mono text-xs text-ink-muted">{r.code}</span>
                    </td>
                    <td data-testid={`procedures-stage-${r.agent.id}`}>
                      {r.paused ? (
                        <>
                          {t("state.agent.paused")}
                          <span className="block text-xs text-ink-muted">{r.stage.words}</span>
                        </>
                      ) : (
                        r.stage.words
                      )}
                    </td>
                    <td>
                      {r.revision ? (
                        <>
                          {r.revision.number}
                          <span className="block text-xs text-ink-muted">
                            {fmt.date(r.revision.at)}
                          </span>
                        </>
                      ) : (
                        <span className="text-ink-muted">{t("sop.notRecorded")}</span>
                      )}
                    </td>
                    <td>
                      {r.revision?.changes[0] ? (
                        <>
                          {r.revision.changes[0].words}
                          {r.revision.changes.length > 1 ? (
                            <span className="text-ink-muted">
                              {" "}
                              {t("procedures.andMore", { count: r.revision.changes.length - 1 })}
                            </span>
                          ) : null}
                          {r.revision.by ? (
                            <span className="block text-xs text-ink-muted">
                              {t("procedures.changedBy", {
                                who: r.revision.by,
                                where: r.revision.where,
                              })}
                            </span>
                          ) : null}
                        </>
                      ) : (
                        "–"
                      )}
                    </td>
                    <td>
                      {r.systems.length === 0 ? (
                        <span className="text-ink-muted">–</span>
                      ) : (
                        <ul className="flex flex-col gap-0.5">
                          {r.systems.map((s) => (
                            <li
                              key={s.key}
                              className={cx(s.key === system && "font-medium")}
                              data-testid={`procedures-system-${r.agent.id}-${s.key}`}
                            >
                              {s.name}
                              <span className="text-ink-muted">
                                {" · "}
                                {sopMayChange(s)
                                  ? t("procedures.does.changes")
                                  : t("procedures.does.reads")}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
