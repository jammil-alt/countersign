import { z } from "zod";
import { TemplateString } from "./common";

export const RuleOp = z.enum([">", ">=", "<", "<=", "=", "!=", "contains", "in", "is", "exists"]);
export type RuleOp = z.infer<typeof RuleOp>;

/** One row of the builder's condition editor: `field op value`. */
export const Rule = z.object({
  field: TemplateString,
  op: RuleOp,
  value: z.unknown().optional(),
});
export type Rule = z.infer<typeof Rule>;

/** Fork path conditions and trigger filters (ARCHITECTURE §10.1). Compiled to JSONLogic. */
export const Rules = z
  .object({
    match: z.enum(["all", "any"]).default("all"),
    rules: z.array(Rule),
  })
  .meta({ id: "Rules" });
export type Rules = z.infer<typeof Rules>;
