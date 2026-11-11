// ⌘K search (ARCHITECTURE §11.6): the header's search box opens a dialog, as does ⌘K or Ctrl+K
// anywhere. Each surface hands in its own `run` (the portal searches its client, the back office
// the clients it serves) that turns the API's hits into groups of links. Arrow keys move, Enter
// opens, Escape closes; every hit is a link to its page.
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useI18n } from "../i18n/i18n";
import { cx } from "../ui/cx";
import { Icon } from "../ui/icons";
import { ErrorNotice } from "../ui/primitives";
import { Skeleton, SkeletonLine } from "../ui/skeleton";

export interface SearchHit {
  /** Unique across the groups. */
  key: string;
  href: string;
  title: string;
  /** A second, muted line: the client, the status, the date. */
  meta?: string | undefined;
}

export interface SearchGroup {
  label: string;
  hits: SearchHit[];
}

export type SearchRun = (q: string, signal: AbortSignal) => Promise<SearchGroup[]>;

/** The portal's last line, under the hits: ask Sloan the words typed ("Ask Sloan: …"). */
export interface SearchAsk {
  label: (q: string) => string;
  href: (q: string) => string;
}

/** How long typing pauses before a search goes out. */
export const SEARCH_DEBOUNCE_MS = 200;

/** The header's box and the dialog behind it. */
export function SearchBox({
  placeholder,
  run,
  ask,
}: {
  placeholder: string;
  run: SearchRun;
  ask?: SearchAsk | undefined;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const { pathname } = useLocation();

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // A hit was opened: the page changed, so the dialog goes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: closes on each page change.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        data-testid="shell-search"
        aria-label={t("shell.search")}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className="ui-searchbox"
      >
        <Icon name="search" className="text-ink-muted" />
        <span className="ui-searchbox__text">{placeholder}</span>
        <kbd className="ui-kbd">⌘K</kbd>
      </button>
      {open ? (
        <SearchDialog
          placeholder={placeholder}
          run={run}
          ask={ask}
          onClose={() => {
            setOpen(false);
            trigger.current?.focus();
          }}
        />
      ) : null}
    </>
  );
}

export function SearchDialog({
  placeholder,
  run,
  ask,
  onClose,
}: {
  placeholder: string;
  run: SearchRun;
  ask?: SearchAsk | undefined;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const id = useId();
  const [q, setQ] = useState("");
  const [state, setState] = useState<{
    groups: SearchGroup[];
    loading: boolean;
    error: unknown;
    searched: string;
  }>({ groups: [], loading: false, error: null, searched: "" });
  const [active, setActive] = useState(0);
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    const text = q.trim();
    if (!text) {
      setState({ groups: [], loading: false, error: null, searched: "" });
      return;
    }
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    const timer = setTimeout(() => {
      runRef.current(text, controller.signal).then(
        (groups) => {
          if (controller.signal.aborted) return;
          setState({
            groups: groups.filter((g) => g.hits.length > 0),
            loading: false,
            error: null,
            searched: text,
          });
          setActive(0);
        },
        (error: unknown) => {
          if (!controller.signal.aborted) {
            setState({ groups: [], loading: false, error, searched: text });
          }
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q]);

  const found = state.groups.flatMap((g) => g.hits);
  const askHit: SearchHit | null =
    ask && q.trim() ? { key: "ask", href: ask.href(q.trim()), title: ask.label(q.trim()) } : null;
  const hits = askHit ? [...found, askHit] : found;
  const activeHit = hits[active];
  const optionId = (key: string) => `${id}-hit-${key}`;

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown" && hits.length > 0) {
      e.preventDefault();
      setActive((a) => (a + 1) % hits.length);
    } else if (e.key === "ArrowUp" && hits.length > 0) {
      e.preventDefault();
      setActive((a) => (a - 1 + hits.length) % hits.length);
    } else if (e.key === "Enter" && activeHit) {
      e.preventDefault();
      navigate(activeHit.href);
      onClose();
    }
  }

  // On document.body: the top bar is its own stacking context, so a dialog inside it would sit
  // under the phone's open sidebar.
  return createPortal(
    <div className="ui-overlay ui-overlay--top" data-testid="search-dialog">
      <button
        type="button"
        aria-label={t("search.close")}
        tabIndex={-1}
        className="ds-scrim ui-scrim-button"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("search.title")}
        className="ds-dialog ui-search"
      >
        <div className="ui-search__field">
          <Icon name="search" className="text-ink-muted" />
          <input
            // biome-ignore lint/a11y/noAutofocus: a search dialog opens to type in.
            autoFocus
            data-testid="search-input"
            role="combobox"
            aria-expanded={hits.length > 0}
            aria-controls={`${id}-list`}
            aria-activedescendant={activeHit ? optionId(activeHit.key) : undefined}
            aria-autocomplete="list"
            aria-label={t("search.title")}
            placeholder={placeholder}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            className="ui-search__input"
          />
          <kbd className="ui-kbd">Esc</kbd>
        </div>
        <div className="ui-search__results">
          {state.error ? <ErrorNotice error={state.error} /> : null}
          {!q.trim() ? <p className="ui-search__note">{t("search.hint")}</p> : null}
          {q.trim() && state.loading && found.length === 0 ? <SearchSkeleton /> : null}
          {q.trim() && !state.loading && !state.error && state.searched && found.length === 0 ? (
            <p className="ui-search__note" data-testid="search-empty">
              {t("search.empty", { q: state.searched })}
            </p>
          ) : null}
          <div id={`${id}-list`} role="listbox" aria-label={t("search.title")}>
            {state.groups.map((g) => (
              // biome-ignore lint/a11y/useSemanticElements: a group inside the ARIA listbox.
              <div key={g.label} role="group" aria-label={g.label} className="ui-search__group">
                <p className="eyebrow ui-search__label">{g.label}</p>
                {g.hits.map((h) => (
                  <Link
                    key={h.key}
                    id={optionId(h.key)}
                    to={h.href}
                    role="option"
                    aria-selected={h === activeHit}
                    data-testid="search-hit"
                    onMouseEnter={() => setActive(hits.indexOf(h))}
                    onClick={onClose}
                    className={cx("ui-search__hit", h === activeHit && "is-active")}
                  >
                    <span className="min-w-0 truncate text-ink">{h.title}</span>
                    {h.meta ? (
                      <span className="min-w-0 truncate text-sm text-ink-muted">{h.meta}</span>
                    ) : null}
                  </Link>
                ))}
              </div>
            ))}
            {askHit ? (
              <Link
                id={optionId(askHit.key)}
                to={askHit.href}
                role="option"
                aria-selected={askHit === activeHit}
                data-testid="search-ask"
                onMouseEnter={() => setActive(hits.length - 1)}
                onClick={onClose}
                className={cx("ui-search__hit", askHit === activeHit && "is-active")}
              >
                <span className="min-w-0 truncate text-ink">{askHit.title}</span>
              </Link>
            ) : null}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** How many hit rows the skeleton draws while the first answer is out. */
export const SEARCH_SKELETON_ROWS = 4;

/**
 * The results' place while a search is out (docs/audit-plan.md 1.3): a group's label and a few
 * hits, each a title and its muted line, in the hits' own classes so the list does not jump when
 * the answer comes. Screen readers hear "Loading…".
 */
function SearchSkeleton() {
  return (
    <Skeleton testId="search-loading">
      <div className="ui-search__group">
        <div className="ui-search__label">
          <SkeletonLine width={64} size="small" />
        </div>
        {Array.from({ length: SEARCH_SKELETON_ROWS }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: identical placeholder rows.
          <div key={i} aria-hidden className="ui-search__hit items-center">
            <SkeletonLine width={i % 2 ? "half" : "long"} className="flex-1" />
            <SkeletonLine width={96} size="small" />
          </div>
        ))}
      </div>
    </Skeleton>
  );
}
