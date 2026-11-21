// Draft (docs/plan.md §1.168): a long text field in the back office drafted from the operator's
// notes. Operator only. The request names the field and the records it is about by id; the server
// loads them itself, within the operator's clients, and never takes their text from the browser.
// Served beside the registry (`allRoutes`): its screen part loads lazily, so the schema stays out
// of the web app's first load.

import { z } from "zod";
import { ASSIST_FIELD_IDS, ASSIST_FIELDS } from "../assist/fields";
import { isUuid } from "../ids";
import { storable } from "../text";
import { defineRoute } from "./contract";

const Id = z.string().refine((v) => isUuid(v), "not an id");

/** The most the operator's notes, or the field's text sent with them, may hold. */
export const ASSIST_NOTES_MAX = 4000;
export const ASSIST_CURRENT_MAX = 20_000;

export const AssistFieldIdSchema = z.enum(ASSIST_FIELD_IDS);

/**
 * The records the field is about, by id. `ref` names one thing on the build: `item:<id>`,
 * `decision:<id>`, `fit:<row id>` or `setup:<field id>` (an issue's key is one of these).
 */
export const AssistContext = z.strictObject({
  buildId: Id.optional(),
  clientId: Id.optional(),
  dealId: Id.optional(),
  fileId: Id.optional(),
  ref: z
    .string()
    .trim()
    .regex(/^[a-z_]+:\S{1,190}$/, "a reference such as fit:<id>")
    .optional(),
});
export type AssistContext = z.infer<typeof AssistContext>;

export const AssistDraftRequest = z
  .strictObject({
    field: AssistFieldIdSchema,
    notes: storable(z.string().trim().max(ASSIST_NOTES_MAX)),
    current: storable(z.string().max(ASSIST_CURRENT_MAX)).optional(),
    context: AssistContext.default({}),
  })
  .superRefine((b, ctx) => {
    if (!b.notes && !b.current?.trim()) {
      ctx.addIssue({ code: "custom", path: ["notes"], message: "write a few notes first" });
    }
    const need = ASSIST_FIELDS[b.field].needs;
    if (need && !b.context[need]) {
      ctx.addIssue({
        code: "custom",
        path: ["context", need],
        message: `this field is drafted for a record: send its ${need}`,
      });
    }
  });
export type AssistDraftRequest = z.input<typeof AssistDraftRequest>;

export const AssistDraft = z.object({ text: z.string() });
export type AssistDraft = z.infer<typeof AssistDraft>;

export const assistRoutes = {
  opsAssistDraft: defineRoute({
    method: "POST",
    path: "/api/ops/assist/draft",
    auth: "session",
    roles: ["operator"],
    summary:
      "Draft a long text field from your notes, in the field's format and within its length; refused when the client it is about is in HIPAA mode and the model's vendor has no BAA",
    body: AssistDraftRequest,
    response: AssistDraft,
  }),
} as const;
