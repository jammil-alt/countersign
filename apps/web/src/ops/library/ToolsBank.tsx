// R8: the Library's Tools bank (`/ops/library/tools`; ARCHITECTURE §10.14 "Six definitions"): one
// fixed action that reads or writes, never deciding. Grouped by connector (and the platform's and
// packs' own), each with what it does, its verb, the record type it touches and how a write is
// taken back. Writes wait for approval by default (invariant 8); some a person always signs. A
// built-in skill that only wraps a tool is retiring: the tool says so, and a step uses it directly.
//
// Plain words (2026-11-12): each row reads by a title and one line (./plain.ts); the tool's whole
// description, the record types it touches and the rest open in a side sheet from the row.
import type { LibraryTool } from "@countersign/core";
import { useState } from "react";
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { ConnectorMark } from "../../connections/ConnectorMark";
import { saysMore } from "../../ui/brief";
import { Loaded } from "../../ui/page";
import { Card, EmptyState, PageHeader, Tag } from "../../ui/primitives";
import { SheetSection, SideSheet } from "../../ui/sheet";
import { ClientScriptTools } from "./ClientScripts";
import { BankSearch, LibraryFrame } from "./LibraryFrame";
import { counted, LIBRARY_PATHS, matches } from "./paths";
import { toolLine, toolName } from "./plain";
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
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <LibraryFrame>
      <PageHeader
        title="Tools"
        subtitle="What an agent can do in a system: look something up, or make a change. Each does one thing the same way every time. A change waits for approval unless you loosen it."
      />
      <Loaded state={state}>
        {(data) => {
          const shown = data.tools.filter(
            (t) =>
              inFilter(t, filter) &&
              matches(search, toolName(t.id), t.id, t.description, t.sourceName, ...t.entities),
          );
          const opened = openId ? data.tools.find((t) => t.id === openId) : undefined;
          const groups = new Map<string, LibraryTool[]>();
          for (const t of shown) groups.set(t.sourceName, [...(groups.get(t.sourceName) ?? []), t]);
          return (
            <>
              {opened ? <ToolSheet tool={opened} onClose={() => setOpenId(null)} /> : null}
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
                  <ToolGroup key={source} source={source} tools={tools} onOpen={setOpenId} />
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

function ToolGroup({
  source,
  tools,
  onOpen,
}: {
  source: string;
  tools: readonly LibraryTool[];
  onOpen: (id: string) => void;
}) {
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
              <th>Undo</th>
            </tr>
          </thead>
          <tbody>
            {tools.map((t) => (
              <ToolRow key={t.id} tool={t} onOpen={() => onOpen(t.id)} />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** What the tool does, and whether a person signs: the row's and the sheet's words. */
function Does({ tool: t }: { tool: LibraryTool }) {
  return (
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
  );
}

function undoText(t: LibraryTool): string {
  return undoWords(t) ?? (t.sideEffect === "none" ? "Nothing to undo" : "Our records only");
}

function ToolRow({ tool: t, onOpen }: { tool: LibraryTool; onOpen: () => void }) {
  return (
    <tr data-testid={`tool-${t.id}`}>
      <td>
        <span className="flex min-w-[16rem] flex-col gap-0.5 py-1">
          <button
            type="button"
            onClick={onOpen}
            aria-haspopup="dialog"
            data-testid={`tool-${t.id}-open`}
            className="self-start text-left font-medium text-ink hover:underline"
          >
            {toolName(t.id)}
          </button>
          <span className="max-w-xl text-sm text-ink-muted" data-testid={`tool-${t.id}-line`}>
            {toolLine(t)}
          </span>
        </span>
      </td>
      <td className="text-sm">
        <Does tool={t} />
      </td>
      <td className="text-sm" data-testid={`tool-${t.id}-undo`}>
        <span className={t.undo && t.undo.kind !== "none" ? "text-ink" : "text-ink-muted"}>
          {undoText(t)}
        </span>
      </td>
    </tr>
  );
}

/**
 * A tool's side sheet: its title and line, then everything the row leaves out: the whole
 * description, the record types it touches, how a change is undone, and its id for the builder.
 */
function ToolSheet({ tool: t, onClose }: { tool: LibraryTool; onClose: () => void }) {
  const line = toolLine(t);
  return (
    <SideSheet
      testId="tool-sheet"
      onClose={onClose}
      eyebrow={
        <span className="flex flex-wrap items-center gap-2.5">
          {t.connector ? (
            <ConnectorMark name={t.sourceName} connector={t.connector} size="sm" />
          ) : null}
          <span className="text-sm text-ink-muted">
            {t.sourceName} · {sideEffectWords(t)}
          </span>
        </span>
      }
      title={toolName(t.id)}
    >
      <p className="text-ink">{line}</p>
      {saysMore(t.description, line) ? (
        <SheetSection label="In full">
          <p className="text-sm whitespace-pre-line text-ink" data-testid="tool-sheet-description">
            {t.description}
          </p>
        </SheetSection>
      ) : null}
      <SheetSection label="What it does">
        <span className="text-sm">
          <Does tool={t} />
        </span>
      </SheetSection>
      <SheetSection label="Record types">
        {t.entities.length > 0 ? (
          <span className="flex flex-wrap gap-1.5">
            {t.entities.map((e) => (
              <Tag key={e}>{e.replace(/_/g, " ")}</Tag>
            ))}
          </span>
        ) : (
          <p className="text-sm text-ink-muted">None named.</p>
        )}
      </SheetSection>
      <SheetSection label="Undo">
        <p className="text-sm text-ink">{undoText(t)}</p>
      </SheetSection>
      {t.wrappedBy.length > 0 ? (
        <SheetSection label="Retiring">
          <p className="text-sm text-ink-muted" data-testid={`tool-${t.id}-wrapped`}>
            Was a skill too ({t.wrappedBy.join(", ")}): retiring, use a step on this tool.
          </p>
        </SheetSection>
      ) : null}
      <SheetSection label="Id">
        <span className="reference text-ink-muted">{t.id}</span>
      </SheetSection>
    </SideSheet>
  );
}
