// Step model §10f (stream N): the back office's record types and custom fields. Operator only
// (invariant 11): the client never defines fields. A client's own fields are read and written in
// that client's scope; shared fields (no client) are offered to every client. A field is never
// deleted: `hidden` removes it from steps and screens and keeps its data.

import { z } from "zod";
import { CUSTOM_FIELD_TYPES, CustomFieldBase, CustomFieldName } from "../records/custom-fields";
import { RecordType, RecordTypeId } from "../records/record-type";
import { Fields } from "../steps/schema";
import { defineRoute } from "./contract";

const OPS = ["operator"] as const;
const ApiId = z.string().min(1).max(200);

/** A custom field as the back office shows it. */
export const CustomFieldView = CustomFieldBase.extend({
  id: z.string(),
  clientId: z.string().nullable(),
  createdAt: z.string(),
});
export type CustomFieldView = z.infer<typeof CustomFieldView>;

const FieldSpec = z.strictObject({
  of: Fields.max(20).optional(),
  record: RecordTypeId.optional(),
});

export const recordTypeRoutes = {
  opsRecordTypes: defineRoute({
    method: "GET",
    path: "/api/ops/record-types",
    auth: "session",
    roles: OPS,
    summary:
      "Every record type the areas declare, with the shared custom fields and, for a client, its own",
    query: z.object({ client: ApiId.optional() }),
    response: z.object({
      recordTypes: z.array(RecordType),
      fields: z.array(CustomFieldView),
    }),
  }),
  opsCustomFieldCreate: defineRoute({
    method: "POST",
    path: "/api/ops/custom-fields",
    auth: "session",
    roles: OPS,
    summary: "Add a custom field to a record type, for one client or shared with every client",
    body: z.strictObject({
      /** The client it is for; left out: shared. */
      clientId: ApiId.optional(),
      recordType: RecordTypeId,
      name: CustomFieldName,
      label: z.string().trim().min(1).max(60),
      type: z.enum(CUSTOM_FIELD_TYPES),
      spec: FieldSpec.default({}),
      required: z.boolean().default(false),
      about: z.string().trim().max(200).default(""),
    }),
    response: z.object({ field: CustomFieldView }),
  }),
  opsCustomFieldUpdate: defineRoute({
    method: "PATCH",
    path: "/api/ops/custom-fields/:id",
    auth: "session",
    roles: OPS,
    summary:
      "Change a custom field's words, whether it is required, or its type before it holds data; or remove it (its data kept)",
    params: z.object({ id: ApiId }),
    body: z.strictObject({
      label: z.string().trim().min(1).max(60).optional(),
      about: z.string().trim().max(200).optional(),
      required: z.boolean().optional(),
      type: z.enum(CUSTOM_FIELD_TYPES).optional(),
      spec: FieldSpec.optional(),
      hidden: z.boolean().optional(),
    }),
    response: z.object({ field: CustomFieldView }),
  }),
};
