// Draft (docs/plan.md §1.168): what a long text field turns Draft on with, and the records a part
// of a page is about. A page sets the scope once (a build's page: the build and its client), and
// each field names only its own id and, where it has one, the thing it is about (`ref`). Types
// only from core, so the forms that take `assist` add nothing to the first load.

import type { AssistContext, AssistFieldId } from "@countersign/core";
import { createContext } from "react";

/** A field id, or the id with what this field is about. */
export type AssistSpec =
  | AssistFieldId
  | { field: AssistFieldId; ref?: string | undefined; context?: AssistContext | undefined };

/** The records the fields inside it are about: by id only; the server loads them. */
export const AssistScope = createContext<AssistContext>({});

export function assistOf(
  spec: AssistSpec,
  scope: AssistContext,
): { field: AssistFieldId; context: AssistContext } {
  if (typeof spec === "string") return { field: spec, context: scope };
  return {
    field: spec.field,
    context: { ...scope, ...spec.context, ...(spec.ref ? { ref: spec.ref } : {}) },
  };
}
