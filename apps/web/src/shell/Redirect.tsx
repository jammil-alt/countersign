// An old address sent on to its new home (docs/ui-plan.md): `:params` carried over by name, the
// query and the hash kept, and the old entry replaced so Back doesn't bounce.
import { Navigate, useLocation, useParams } from "react-router-dom";

/**
 * `/services/:id` → `<Redirect to="/agents/:id" />`. A `*` in `to` takes the rest of the path. A
 * query in `to` (`/?view=weekly`) is merged with the old address's own (`?week=…`).
 */
export function Redirect({ to }: { to: string }) {
  const params = useParams();
  const { search, hash } = useLocation();
  const [path, query = ""] = to.split("?");
  return (
    <Navigate to={`${fillPath(path ?? "/", params)}${mergeQuery(query, search)}${hash}`} replace />
  );
}

/** Fills `:name` segments and a trailing `*` from the matched params. */
export function fillPath(to: string, params: Readonly<Record<string, string | undefined>>): string {
  const segments = to.split("/").map((seg) => {
    if (seg === "*") return params["*"] ?? "";
    if (seg.startsWith(":")) return encodeURIComponent(params[seg.slice(1)] ?? "");
    return seg;
  });
  while (segments.length > 1 && segments[segments.length - 1] === "") segments.pop();
  return segments.join("/") || "/";
}

/**
 * The new home's fixed query, then the old address's own: `("view=weekly", "?week=2026-11-02")` →
 * `"?view=weekly&week=2026-11-02"`. The new home's value wins where both name the same key.
 */
export function mergeQuery(fixed: string, search: string): string {
  if (!fixed) return search;
  const out = new URLSearchParams(fixed);
  for (const [k, v] of new URLSearchParams(search)) if (!out.has(k)) out.append(k, v);
  const s = out.toString();
  return s ? `?${s}` : "";
}
