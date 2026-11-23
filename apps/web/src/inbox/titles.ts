// An inbox item's title in the reader's language where the server said it by key (S5.7, overnight
// fixes 2026-11-23): a directory suggestion's "Add … to the directory" was English in every
// language. Every other item keeps the title it was given.
import {
  DirectorySuggestionChange,
  directorySuggestionTitle,
  isPlainObject,
} from "@countersign/core";
import type { Translate } from "../i18n/catalog";

type Loose = (key: string, params?: Record<string, string>) => string;

/** The item's title: a directory suggestion's from its key, anything else as given. */
export function itemTitle(item: { title: string; payload?: unknown }, t: Translate): string {
  const s = isPlainObject(item.payload) ? item.payload.directorySuggestion : undefined;
  if (!isPlainObject(s)) return item.title;
  const tr = t as unknown as Loose;
  let key: string | null = null;
  let name: string | null = null;
  const stored = isPlainObject(s.title) ? s.title : null;
  if (stored && typeof stored.key === "string") {
    key = stored.key;
    const params = isPlainObject(stored.params) ? stored.params : {};
    name = typeof params.name === "string" ? params.name : null;
  } else {
    // An item made before the key: an addition names itself in its change.
    const change = DirectorySuggestionChange.safeParse(s.change);
    if (change.success && change.data.action.startsWith("add_")) {
      const said = directorySuggestionTitle(change.data);
      key = said.key;
      name = said.params.name;
    }
  }
  if (!key || !name) return item.title;
  const text = tr(key, { name });
  return text === key ? item.title : text;
}
