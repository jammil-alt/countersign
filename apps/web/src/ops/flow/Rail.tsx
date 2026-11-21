// The rail on the left of the one-screen builder (docs/builder-plan.md §12.2): "Add a step". It
// holds today's catalog and nothing more: Skills; Automations; Tools, by tool, each opening to its
// reads and writes; People; Logic; Other agents (Hand off); triggers only when the host asks. A
// search narrows it with today's word match (`filterSections`), and the words can go to the
// Builder instead ("Ask the Builder: …"). Items are dragged onto the chart (`@dnd-kit`; the host
// owns the DndContext) or pressed to be added. It folds to a thin strip.

import { SKILL_KIND_LABEL, toolUsesModel } from "@countersign/core";
import { useDraggable } from "@dnd-kit/core";
import { type PointerEventHandler, useState } from "react";
import { Icon } from "../../ui/icons";
import { cx } from "../../ui/primitives";
import { filterSections, type PaletteSection } from "../builder/catalog";
import type { PaletteItem } from "../builder/model";
import { plural } from "./status";

/** What a rail item carries while it is dragged (the chart's drop reads `item`). */
export interface RailDragData {
  type: "palette";
  item: PaletteItem;
}

/** The drag id of a rail item. */
export function railDragId(item: Pick<PaletteItem, "key">): string {
  return `flow-palette:${item.key}`;
}

export interface RailProps {
  /** `paletteSections` from ../builder/catalog, for the agent and the connectors it may use. */
  sections: readonly PaletteSection[];
  /** Press an item: the host adds it (at the end, or where + was pressed). */
  onPick(item: PaletteItem): void;
  /** Send the search's words to the Builder. Absent: the row isn't offered. */
  onSay?: ((words: string) => void) | undefined;
  /** Offer the triggers too (a new start), as their own section at the top. */
  triggers?: boolean | undefined;
  /** Controlled fold; uncontrolled when absent. */
  folded?: boolean | undefined;
  onFold?: ((folded: boolean) => void) | undefined;
  /** Controlled search; uncontrolled when absent. */
  search?: string | undefined;
  onSearch?: ((search: string) => void) | undefined;
}

type Group =
  | { kind: "items"; key: string; label: string; items: PaletteItem[] }
  | { kind: "tools"; key: string; label: string; tools: PaletteSection[] };

/** The rail's sections in its order, from the palette's. */
export function railGroups(sections: readonly PaletteSection[], triggers: boolean): Group[] {
  const by = (key: string) => sections.find((s) => s.key === key);
  const items = (key: string, label: string): Group[] => {
    const s = by(key);
    return s && s.items.length > 0 ? [{ kind: "items", key, label, items: s.items }] : [];
  };
  // Tools by tool: each connector's section, then the actions (a write resolved from the agent's
  // connections when it runs) as one more "tool".
  const tools = sections.filter((s) => s.key.startsWith("connector:") || s.key === "actions");
  const ordered = [
    ...tools.filter((s) => s.key !== "actions"),
    ...tools.filter((s) => s.key === "actions"),
  ].filter((s) => s.items.length > 0);
  return [
    ...(triggers ? items("triggers", "Starts when") : []),
    ...items("skills", "Skills"),
    ...items("processes", "Automations"),
    ...(ordered.length
      ? [{ kind: "tools" as const, key: "tools", label: "Tools", tools: ordered }]
      : []),
    ...items("people", "People"),
    ...items("logic", "Logic"),
    ...items("handoff", "Other agents"),
  ];
}

/** "1 skill · 2 reads · 1 write" under a tool's name. */
export function toolLine(items: readonly PaletteItem[]): string {
  const skills = items.filter((i) => i.type === "skill").length;
  const reads = items.filter((i) => i.type === "read").length;
  const writes = items.filter((i) => i.type === "write" || i.type === "action").length;
  return [skills ? plural(skills, "skill") : null, plural(reads, "read"), plural(writes, "write")]
    .filter(Boolean)
    .join(" · ");
}

export function Rail(props: RailProps) {
  const [ownFolded, setOwnFolded] = useState(false);
  const [ownSearch, setOwnSearch] = useState("");
  const folded = props.folded ?? ownFolded;
  const search = props.search ?? ownSearch;
  const fold = (f: boolean) => {
    setOwnFolded(f);
    props.onFold?.(f);
  };
  const setSearch = (s: string) => {
    setOwnSearch(s);
    props.onSearch?.(s);
  };

  if (folded) {
    return (
      <aside
        aria-label="Add a step"
        data-testid="flow-rail"
        data-folded=""
        className="flex h-full w-10 flex-col items-center gap-3 border-r border-line bg-surface py-3 max-[900px]:w-full max-[900px]:flex-row max-[900px]:border-r-0 max-[900px]:px-4"
      >
        <button
          type="button"
          aria-label="Show the steps you can add"
          title="Show the steps you can add"
          data-testid="flow-rail-unfold"
          onClick={() => fold(false)}
          className="ds-btn ds-btn--ghost ds-btn--icon ds-btn--sm text-ink-muted hover:text-ink"
        >
          <Icon name="sidebar" />
        </button>
        <button
          type="button"
          onClick={() => fold(false)}
          className="flex items-center gap-1.5 text-xs text-ink-muted [writing-mode:vertical-rl] hover:text-ink max-[900px]:[writing-mode:horizontal-tb]"
        >
          <Icon name="add" />
          Add a step
        </button>
      </aside>
    );
  }

  const words = search.trim();
  const groups = railGroups(
    words ? filterSections([...props.sections], words) : props.sections,
    props.triggers ?? false,
  );
  return (
    <aside
      aria-label="Add a step"
      data-testid="flow-rail"
      className="flex h-full min-h-0 w-64 flex-col border-r border-line bg-surface max-[900px]:w-full max-[900px]:border-r-0"
    >
      <div className="flex flex-col gap-2 border-b border-line px-4 pt-3 pb-3">
        <div className="flex items-center justify-between">
          <span className="eyebrow text-ink-muted">Add a step</span>
          <button
            type="button"
            aria-label="Hide this list"
            title="Hide this list"
            data-testid="flow-rail-fold"
            onClick={() => fold(true)}
            className="ds-btn ds-btn--ghost ds-btn--icon ds-btn--sm text-ink-muted hover:text-ink"
          >
            <Icon name="sidebar" />
          </button>
        </div>
        <input
          type="search"
          aria-label="Search steps, or say what the step should do"
          placeholder="Search, or say what it should do"
          data-testid="flow-rail-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && search) {
              e.stopPropagation();
              setSearch("");
            }
          }}
          className="ds-input text-sm"
        />
        <p className="text-xs text-ink-muted">
          {words
            ? "Drag a step onto the flow, or press it to add it."
            : "Try “email the vendor” or “wait two days”. Drag a step onto the flow, or press + on an arrow."}
        </p>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-3">
        {words && props.onSay ? (
          <button
            type="button"
            data-testid="flow-rail-say"
            onClick={() => props.onSay?.(words)}
            className="flex items-start gap-2 rounded-md border border-line px-2.5 py-2 text-left text-sm hover:border-line-strong"
          >
            <Icon name="message" className="mt-0.5 text-ink-muted" />
            <span className="min-w-0">
              <span className="text-ink">Ask the Builder: </span>
              <span className="text-ink [overflow-wrap:anywhere]">“{words}”</span>
              <span className="block text-xs text-ink-muted">
                It reads your words and picks the kind of step and the part.
              </span>
            </span>
          </button>
        ) : null}
        {words && groups.length === 0 ? (
          <p className="text-sm text-ink-muted" data-testid="flow-rail-none">
            No step in the library matches.
          </p>
        ) : null}
        {groups.map((g) => (
          <details
            key={g.key}
            open
            data-testid={`flow-rail-${g.key}`}
            className="group/rail flex flex-col"
          >
            <summary className="flex cursor-pointer list-none [&::-webkit-details-marker]:hidden items-center justify-between border-b border-line pb-1.5 eyebrow text-ink-muted">
              {g.label}
              <span className="figures">
                {g.kind === "tools" ? g.tools.length : g.items.length}
              </span>
            </summary>
            <div className="flex flex-col gap-1.5 pt-2">
              {g.kind === "tools"
                ? g.tools.map((t) => (
                    <ToolGroup
                      key={t.key}
                      section={t}
                      open={words.length > 0}
                      onPick={props.onPick}
                    />
                  ))
                : g.items.map((item) => (
                    <RailItem key={item.key} item={item} onPick={props.onPick} />
                  ))}
            </div>
          </details>
        ))}
      </div>
    </aside>
  );
}

function ToolGroup({
  section,
  open,
  onPick,
}: {
  section: PaletteSection;
  open: boolean;
  onPick(item: PaletteItem): void;
}) {
  const id = section.key.replace(/^connector:/, "");
  return (
    <details
      open={open || undefined}
      data-testid={`flow-rail-tool-${id}`}
      className="rounded-md border border-line"
    >
      <summary className="flex cursor-pointer list-none [&::-webkit-details-marker]:hidden items-center gap-2.5 px-2.5 py-2">
        <span
          aria-hidden
          className="flex size-7 shrink-0 items-center justify-center rounded-sm border border-line bg-surface-subtle text-xs font-medium text-ink"
        >
          {section.label.slice(0, 2)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-ink">{section.label}</span>
          <span className="block text-xs text-ink-muted" data-testid={`flow-rail-tool-${id}-line`}>
            {toolLine(section.items)}
          </span>
        </span>
        <Icon name="chevron-right" className="text-ink-muted" />
      </summary>
      <div className="flex flex-col gap-1.5 border-t border-line p-2">
        {section.items.map((item) => (
          <RailItem key={item.key} item={item} onPick={onPick} />
        ))}
      </div>
    </details>
  );
}

const ITEM_WORD: Partial<Record<PaletteItem["type"], string>> = {
  read: "Read",
  write: "Write",
  action: "Write",
};

function RailItem({ item, onPick }: { item: PaletteItem; onPick(item: PaletteItem): void }) {
  const data: RailDragData = { type: "palette", item };
  const { listeners, setNodeRef, isDragging } = useDraggable({ id: railDragId(item), data });
  // A read or a write whose tool calls a model inside says AI too (F6: as the palette did).
  const kind =
    item.type === "skill" && item.kind
      ? SKILL_KIND_LABEL[item.kind]
      : (item.type === "read" || item.type === "write") && toolUsesModel(item.tool)
        ? `${ITEM_WORD[item.type]} · ${SKILL_KIND_LABEL.ai}`
        : ITEM_WORD[item.type];
  return (
    <button
      ref={setNodeRef}
      type="button"
      title={item.detail}
      data-testid={`flow-rail-item-${item.key}`}
      // Pointer drags only: Enter and Space press the button, which adds the step.
      onPointerDown={listeners?.onPointerDown as PointerEventHandler<HTMLButtonElement> | undefined}
      onClick={() => onPick(item)}
      className={cx(
        "flex w-full cursor-grab touch-none items-start gap-2 rounded-md border border-line bg-surface px-2.5 py-2 text-left hover:border-line-strong",
        isDragging && "opacity-40",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-ink [overflow-wrap:anywhere]">{item.title}</span>
        <span className="line-clamp-1 text-xs text-ink-muted">{item.detail}</span>
      </span>
      {kind ? (
        <span
          className="ds-tag shrink-0 whitespace-nowrap"
          data-testid={`flow-rail-item-${item.key}-kind`}
        >
          {kind}
        </span>
      ) : null}
    </button>
  );
}
