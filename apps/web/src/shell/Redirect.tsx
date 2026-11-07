// An old address sent on to its new home (docs/ui-plan.md): `:params` carried over by name, the
// query and the hash kept, and the old entry replaced so Back doesn't bounce.
import { Navigate, useLocation, useParams } from "react-router-dom";

/**
 * `/services/:id` → `<Redirect to="/agents/:id" />`. A `*` in `to` takes the rest of the path. A
 * query in `to` (`/contacts?show=organizations`) is kept, with the old address's own query after it.
 */
export function Redirect({ to }: { to: string }) {
  const params = useParams();
  const { search, hash } = useLocation();
  return <Navigate to={`${redirectTarget(to, params, search)}${hash}`} replace />;
}

/** The new address: `to` filled from the params, its own query merged with the old one. */
export function redirectTarget(
  to: string,
  params: Readonly<Record<string, string | undefined>>,
  search: string,
): string {
  const [path = "", own = ""] = to.split("?");
  const query = new URLSearchParams(own);
  for (const [k, v] of new URLSearchParams(search)) if (!query.has(k)) query.append(k, v);
  const q = query.toString();
  return `${fillPath(path, params)}${q ? `?${q}` : ""}`;
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
