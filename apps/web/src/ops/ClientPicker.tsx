// The top bar's client picker. Picking a client opens its page in the back office; "All clients"
// opens Home. Feedback (2026-11-10): "make the drop down searchable", and "is it supposed to log me
// into the client's accounts?" It is a list you can type into, and its first line says what it
// does: you stay signed in as yourself, and it never signs in to a client's tools.
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { cx } from "../ui/cx";
import { Icon } from "../ui/icons";
import { OPS_PATHS } from "./paths";

export interface PickerClient {
  id: string;
  name: string;
}

/** The clients whose name holds every word typed, in their order; "All clients" isn't one. */
export function filterClients(
  clients: readonly PickerClient[],
  query: string,
): readonly PickerClient[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return clients;
  return clients.filter((c) => {
    const name = c.name.toLowerCase();
    return words.every((w) => name.includes(w));
  });
}

export function ClientPicker({
  selected,
  clients,
  onPick,
}: {
  selected: string | null;
  clients: readonly PickerClient[];
  onPick: (id: string | null) => void;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const listId = useId();
  // A remembered client this operator no longer serves shows as all clients.
  const current = selected ? (clients.find((c) => c.id === selected) ?? null) : null;
  const searching = query.trim() !== "";
  const options = useMemo(
    () => [
      // "All clients" is offered until a search narrows the list.
      ...(searching ? [] : [{ id: "", name: "All clients" }]),
      ...filterClients(clients, query),
    ],
    [clients, query, searching],
  );

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  function show() {
    setQuery("");
    const at = current ? clients.findIndex((c) => c.id === current.id) + 1 : 0;
    setActive(Math.max(0, at));
    setOpen(true);
  }

  function close(focusTrigger = true) {
    setOpen(false);
    if (focusTrigger) trigger.current?.focus();
  }

  function pick(id: string) {
    const next = id || null;
    onPick(next);
    navigate(next ? OPS_PATHS.client(next) : OPS_PATHS.command);
    close();
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const option = options[active];
      if (option) pick(option.id);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  const optionId = (i: number) => `${listId}-${i}`;
  return (
    <div ref={root} className="relative flex items-center">
      <button
        ref={trigger}
        type="button"
        data-testid="ops-client-switcher"
        data-value={current?.id ?? ""}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Client: ${current?.name ?? "All clients"}`}
        title="Open a client's page"
        onClick={() => (open ? close() : show())}
        className="ds-select flex h-8 max-w-56 items-center bg-surface-subtle pr-8 pl-2 text-left text-sm font-medium hover:border-line-strong"
      >
        <span className="truncate">{current?.name ?? "All clients"}</span>
      </button>
      <Icon
        name="chevron-down"
        className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-ink-muted"
      />
      {open ? (
        <div
          data-testid="ops-client-switcher-menu"
          className="absolute top-full left-0 z-30 mt-2 flex w-80 max-w-[calc(100vw-32px)] flex-col gap-2 rounded-md border border-line bg-surface p-3"
        >
          <p className="text-xs text-ink-muted" data-testid="ops-client-switcher-hint">
            Opens the client's page here in the back office. You stay signed in as yourself; it
            never signs in to a client's tools.
          </p>
          <input
            ref={input}
            type="search"
            role="combobox"
            aria-label="Find a client"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={options[active] ? optionId(active) : undefined}
            data-testid="ops-client-switcher-search"
            placeholder="Find a client"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKey}
            className="ds-input h-8 text-sm"
          />
          <div
            id={listId}
            role="listbox"
            aria-label="Clients"
            className="flex max-h-72 flex-col overflow-y-auto"
          >
            {options.map((c, i) => {
              const chosen = (current?.id ?? "") === c.id;
              return (
                // biome-ignore lint/a11y/useKeyWithClickEvents: the search box's arrows and Enter pick by keyboard.
                <div
                  key={c.id || "all"}
                  id={optionId(i)}
                  role="option"
                  tabIndex={-1}
                  aria-selected={chosen}
                  data-testid={`ops-client-switcher-option-${c.id || "all"}`}
                  onPointerEnter={() => setActive(i)}
                  onClick={() => pick(c.id)}
                  className={cx(
                    "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm",
                    i === active ? "bg-surface-subtle" : "",
                    chosen ? "font-medium text-slate" : "text-ink",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  {chosen ? <Icon name="check" size={14} /> : null}
                </div>
              );
            })}
            {options.length === 0 ? (
              <p
                className="px-2 py-1.5 text-sm text-ink-muted"
                data-testid="ops-client-switcher-none"
              >
                No client matches “{query.trim()}”.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
