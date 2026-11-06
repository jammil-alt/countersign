// An old address sent on to its new home (docs/ui-plan.md): `:params` carried over by name, the
// query and the hash kept, and the old entry replaced so Back doesn't bounce.
import { Navigate, useLocation, useParams } from "react-router-dom";

/** `/services/:id` → `<Redirect to="/agents/:id" />`. A `*` in `to` takes the rest of the path. */
export function Redirect({ to }: { to: string }) {
  const params = useParams();
  const { search, hash } = useLocation();
  return <Navigate to={`${fillPath(to, params)}${search}${hash}`} replace />;
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
