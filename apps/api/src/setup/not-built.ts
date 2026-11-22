// The Getting started streams' seams (docs/plan.md §1.185): while a stream is being built its
// functions throw this and its routes answer 501 `not_built`, naming it; the route contract and the
// mount are in place, so the contract tests hold from the start. Removed once every stream is in.
import { HttpError } from "../http";

export function notBuilt(stream: "TOOLS" | "SEE" | "LIVE" | "OPS"): never {
  throw new HttpError(501, "not_built", `Getting started's ${stream} stream isn't built yet`);
}
