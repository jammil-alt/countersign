// R8: the Library's Condition sets bank (`/ops/library/conditions`; ARCHITECTURE §10.14 "The
// Library", "Checks"): plain rules a check or an `if` step tests, never a model. Named sets have no
// storage yet, so this bank shows the conditions the processes use, read from each template's live
// (else latest) version and each automation's, grouped where the same rules are used more than
// once, with every place that uses them and a link to edit it there. Read only.
import type { LibraryConditionSet, LibraryConditionUse } from "@countersign/core";
import { useState } from "react";
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { Loaded } from "../../ui/page";
import { Card, EmptyState, PageHeader, Tag } from "../../ui/primitives";
import { Notice } from "../agents/ui";
import { automationPath } from "../skills/SkillsLibrary";
import { rulesText } from "../workflow/describe";
import { BankSearch, LibraryFrame } from "./LibraryFrame";
import { builderPath } from "./ProcessesBank";
import { counted, matches } from "./paths";
import { PLACE_LABEL } from "./words";

function linkTo(u: LibraryConditionUse): { to: string; state?: { agentId: string } } {
  if (u.processKind === "automation") return { to: automationPath(u.processId) };
  return {
    to: u.workflow
      ? builderPath(u.processSlug, u.workflow)
      : `/ops/templates/${u.processSlug}/workflow`,
    state: { agentId: u.processId },
  };
}

/**
 * Each use with a key: where it is, and how many times before at the same place (a step may carry
 * two notifies with the same rules).
 */
function keyedUses(uses: readonly LibraryConditionUse[]): [LibraryConditionUse, string][] {
  const seen = new Map<string, number>();
  return uses.map((u) => {
    const at = `${u.processKind}:${u.processId}:${u.workflow}:${u.stepId}:${u.place}:${u.label}`;
    const n = (seen.get(at) ?? 0) + 1;
    seen.set(at, n);
    return [u, `${at}#${n}`];
  });
}

function processCount(set: LibraryConditionSet): number {
  return new Set(set.uses.map((u) => `${u.processKind}:${u.processId}`)).size;
}

export function ConditionsBank() {
  const state = useApi(apiRoutes.opsLibraryConditions);
  const [search, setSearch] = useState("");
  return (
    <LibraryFrame>
      <PageHeader
        title="Condition sets"
        subtitle="Plain rules over the run that a check or an if step tests: “when the total is over $5,000”. Never a model."
      />
      <Notice tone="neutral" testId="conditions-derived">
        These are the conditions your processes use today, grouped where the same rules appear more
        than once. Naming a set to reuse it needs its own storage, which isn't built yet; edit a
        condition where it is used.
      </Notice>
      <div className="flex justify-end">
        <BankSearch
          value={search}
          onChange={setSearch}
          label="Search conditions"
          testId="conditions-search"
        />
      </div>
      <Loaded state={state}>
        {(data) => {
          const shown = data.sets.filter((s) =>
            matches(
              search,
              s.name,
              rulesText(s.when),
              ...s.uses.flatMap((u) => [u.processName, u.stepName, u.label]),
            ),
          );
          if (data.sets.length === 0) {
            return <EmptyState>No process tests a condition yet.</EmptyState>;
          }
          if (shown.length === 0) return <EmptyState>No condition matches.</EmptyState>;
          return (
            <div className="flex flex-col gap-4">
              {shown.map((s) => (
                <ConditionCard key={s.key} set={s} />
              ))}
            </div>
          );
        }}
      </Loaded>
    </LibraryFrame>
  );
}

function ConditionCard({ set: s }: { set: LibraryConditionSet }) {
  return (
    <Card
      testId={`condition-${s.key}`}
      title={
        <span className="flex flex-col gap-1">
          <span>{s.name ?? "Unnamed condition"}</span>
          <span className="text-sm font-normal text-ink" data-testid={`condition-${s.key}-rules`}>
            When {rulesText(s.when)}
          </span>
        </span>
      }
      meta={`${counted(s.uses.length, "use")} · ${counted(processCount(s), "process", "processes")}`}
    >
      <ul className="divide-y divide-line">
        {keyedUses(s.uses).map(([u, key]) => {
          const link = linkTo(u);
          return (
            <li
              key={key}
              className="flex flex-wrap items-center justify-between gap-3 px-6 py-3 text-sm"
            >
              <span className="flex min-w-0 flex-wrap items-baseline gap-2">
                <Link
                  to={link.to}
                  {...(link.state ? { state: link.state } : {})}
                  className="font-medium text-ink hover:underline"
                >
                  {u.processName}
                </Link>
                <span className="reference text-ink-muted">v{u.version}</span>
                {u.processKind === "automation" ? <Tag>Used inside others</Tag> : null}
                <span className="text-ink">
                  {u.stepName ?? (u.label ? `Trigger ${u.label}` : "")}
                  {u.place === "if_path" && u.label ? ` · ${u.label}` : ""}
                </span>
              </span>
              <Tag>{PLACE_LABEL[u.place]}</Tag>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
