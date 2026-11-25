// Step model §10f: the database's custom field types are core's, so a field the back office can
// define is one the table takes (custom_field_type_check).
import { CUSTOM_FIELD_TYPES as CORE_TYPES } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { CUSTOM_FIELD_TYPES } from "./schema";

describe("custom field types", () => {
  it("are core's", () => {
    expect([...CUSTOM_FIELD_TYPES]).toEqual([...CORE_TYPES]);
  });
});
