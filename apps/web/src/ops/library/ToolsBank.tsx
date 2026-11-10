// R8: the Library's Tools bank (`/ops/library/tools`; ARCHITECTURE §10.14 "Six definitions"): one
// fixed action that reads or writes, never deciding. Grouped by connector (and the platform's and
// packs' own), each with what it does, its verb, the record type it touches and how a write is
// taken back. Writes wait for approval by default (invariant 8); some a person always signs. A
// built-in skill that only wraps a tool is retiring: the tool says so, and a step uses it directly.
import type { LibraryTool } from "@countersign/core";
import { useState } from "react";
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { ConnectorMark } from "../../connections/ConnectorMark";
import { Loaded } from "../../ui/page";
import { Card, EmptyState, PageHeader, Tag } from "../../ui/primitives";
import { ClientScriptTools } from "./ClientScripts";
import { BankSearch, LibraryFrame } from "./LibraryFrame";
import { counted, LIBRARY_PATHS, matches } from "./paths";
import { sideEffectWords, undoWords } from "./words";

type Filter = "all" | "reads" | "writes" | "ours";

const FILTERS: [Filter, string][] = [
  ["all", "All"],
  ["reads", "Reads"],
  ["writes", "Writes to a client's tool"],
  ["ours", "Writes to our records"],
];

function inFilter(t: LibraryTool, f: Filter): boolean {
  if (f === "reads") return t.sideEffect === "none";
  if (f === "writes") return t.sideEffect === "external";
  if (f === "ours") return t.sideEffect === "internal";
  return true;
}

export function ToolsBank() {
  const state = useApi(apiRoutes.opsLibraryTools);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  return (
    <LibraryFrame>
      <PageHeader
        title="Tools"
        subtitle="One fixed action each: the same input makes the same call. Skills think, tools act; every write waits for approval unless you loosen it."
      />
      <Loaded state={state}>
        {(data) => {
          const shown = data.tools.filter(
            (t) =>
              inFilter(t, filter) &&
              matches(search, t.id, t.description, t.sourceName, ...t.entities),
          );
          const groups = new Map<string, LibraryTool[]>();
          for (const t of shown) groups.set(t.sourceName, [...(groups.get(t.sourceName) ?? []), t]);
          return (
            <>
              <div className="-mt-2 flex flex-wrap items-center justify-between gap-3">
                <div className="ds-seg flex-wrap" data-testid="tools-filter">
                  {FILTERS.map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={filter === value}
                      data-testid={`tools-filter-${value}`}
                      onClick={() => setFilter(value)}
                    >
                      {label} · {data.tools.filter((t) => inFilter(t, value)).length}
                    </button>
                  ))}
                </div>
                <BankSearch
                  value={search}
                  onChange={setSearch}
                  label="Search tools"
                  testId="tools-search"
                />
              </div>
              {data.tools.length === 0 ? (
                <EmptyState>No tool is registered here.</EmptyState>
              ) : shown.length === 0 ? (
                <EmptyState>No tool matches.</EmptyState>
              ) : (
                [...groups.entries()].map(([source, tools]) => (
                  <ToolGroup key={source} source={source} tools={tools} />
                ))
              )}
              {/* Wave 4: the picked client's published scripts, under the browser connector. */}
              <ClientScriptTools />
            </>
          );
        }}
      </Loaded>
    </LibraryFrame>
  );
}

function ToolGroup({ source, tools }: { source: string; tools: readonly LibraryTool[] }) {
  const connector = tools[0]?.connector ?? null;
  return (
    <Card
      testId={`tools-group-${tools[0]?.source ?? source}`}
      title={
        <span className="flex items-center gap-3">
          {connector ? <ConnectorMark name={source} connector={connector} size="sm" /> : null}
          {source}
        </span>
      }
      meta={
        <>
          <span>{counted(tools.length, "tool")}</span>
          {connector ? (
            <Link to={LIBRARY_PATHS.connectors} className="text-ink hover:underline">
              Connector
            </Link>
          ) : null}
        </>
      }
    >
      <div className="dt dt-ana overflow-x-auto">
        <table>
          <thead>
            <tr className="dt-cols">
              <th>Tool</th>
              <th>Does</th>
              <th>Record type</th>
              <th>Undo</th>
            </tr>
          </thead>
          <tbody>
            {tools.map((t) => (
              <ToolRow key={t.id} tool={t} />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function ToolRow({ tool: t }: { tool: LibraryTool }) {
  const undo = undoWords(t);
  return (
    <tr data-testid={`tool-${t.id}`}>
      <td>
        <span className="flex flex-col gap-1">
          <span className="reference text-ink">{t.id}</span>
          <span className="text-sm text-ink-muted">{t.description}</span>
          {t.wrappedBy.length > 0 ? (
            <span className="text-xs text-ink-muted" data-testid={`tool-${t.id}-wrapped`}>
              Was a skill too ({t.wrappedBy.join(", ")}): retiring, use a step on this tool
            </span>
          ) : null}
        </span>
      </td>
      <td className="text-sm">
        <span className="flex flex-col items-start gap-1">
          <span className="text-ink" data-testid={`tool-${t.id}-does`}>
            {sideEffectWords(t)} · {t.verb}
          </span>
          {t.alwaysSigned ? (
            <Tag tone="person" testId={`tool-${t.id}-signed`}>
              A person always signs
            </Tag>
          ) : t.sideEffect === "external" ? (
            <span className="text-xs text-ink-muted">Approval on by default</span>
          ) : null}
        </span>
      </td>
      <td className="text-sm text-ink">
        {t.entities.length > 0 ? t.entities.join(", ") : <span className="text-ink-muted">—</span>}
      </td>
      <td className="text-sm" data-testid={`tool-${t.id}-undo`}>
        {undo ? (
          <span className={t.undo?.kind === "none" ? "text-ink-muted" : "text-ink"}>{undo}</span>
        ) : (
          <span className="text-ink-muted">
            {t.sideEffect === "none" ? "Nothing to undo" : "Our records only"}
          </span>
        )}
      </td>
    </tr>
  );
}
