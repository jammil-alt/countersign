// What a run is about, for its title in lists, search and its page on both sides ("Northline Panel
// Supply · Invoice 20418"), rather than the trigger that started it ("When an invoice has been
// read"). Built when a response is built, from what the run kept (`run_subject`) where it has it,
// else from its trigger and its changes (docs/plan.md §1.188). The words are the reader's: the
// API sends the parts, each surface puts them into its own language.
import { z } from "zod";
import { LocalizedString } from "../i18n/locale";
import { isPlainObject } from "../json";
import { RunSubjectKind } from "../schemas/tool-about";
import { changeValue, type ToolDisplay } from "../schemas/tool-display";
import { RunStartedBy } from "./runs-filter";

export const RunSubject = z.discriminatedUnion("kind", [
  /** A document started the run: its latest reading's vendor and invoice number, else its file. */
  z.object({
    kind: z.literal("document"),
    vendor: z.string().nullable(),
    number: z.string().nullable(),
    filename: z.string().nullable(),
  }),
  /**
   * The run's first change to a client's tool, as its card heads it: the tool's display name
   * ("QuickBooks bill"), the record's number and whom it is with.
   */
  z.object({
    kind: z.literal("change"),
    name: LocalizedString,
    number: z.string().nullable(),
    with: z.string().nullable(),
  }),
  /**
   * Neither, but a record the run kept as its subject (`run_subject`, docs/plan.md §1.188): a
   * purchasing request, a vendor, a booking, by its name and number. Data, never instructions.
   */
  z.object({
    kind: z.literal("record"),
    of: RunSubjectKind,
    label: z.string().nullable(),
    number: z.string().nullable(),
  }),
  /** None of these: what started it, in the surface's own words. */
  z.object({
    kind: z.literal("trigger"),
    startedBy: RunStartedBy.nullable(),
    /** The event type, for an event trigger (the back office names it; the portal doesn't). */
    event: z.string().nullable(),
  }),
]);
export type RunSubject = z.infer<typeof RunSubject>;

function text(v: unknown): string | null {
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/** A `{ id, name }` reference's name, or a plain value. */
function named(v: unknown): string | null {
  if (isPlainObject(v)) {
    for (const k of ["name", "displayName", "title", "label"]) {
      const n = text(v[k]);
      if (n) return n;
    }
    return null;
  }
  return text(v);
}

/**
 * A change's subject from its tool's display (the same reading as the card's heading), or from
 * the connector's name and the record's own name when the tool declares no display.
 */
export function changeSubject(
  display: ToolDisplay | null | undefined,
  connectorName: string,
  before: unknown,
  input: unknown,
): Extract<RunSubject, { kind: "change" }> {
  const ctx = { before, input };
  if (!display) {
    const b = isPlainObject(before) ? before : {};
    const i = isPlainObject(input) ? input : {};
    return {
      kind: "change",
      name: connectorName,
      number: null,
      with: named(b.name) ?? named(b.title) ?? named(i.name) ?? named(i.title),
    };
  }
  const variant = display.nameBy ? text(changeValue(ctx, display.nameBy.path)) : null;
  return {
    kind: "change",
    name: (variant !== null ? display.nameBy?.names[variant] : undefined) ?? display.name,
    number: text(changeValue(ctx, display.number)),
    with: named(changeValue(ctx, display.subject)),
  };
}
