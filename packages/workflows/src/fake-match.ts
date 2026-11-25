// A fake Match port for tests (the step model, docs/step-model-plan.md §7): matches each input item
// by its `sku` against a fixed list, exact only; an item whose sku has `unsure` candidates is left
// for a person, with those candidates. It records what it was asked and what it learned. Stream
// D's engine takes its place outside tests.

import type {
  MatchItem,
  MatchLearnRequest,
  MatchNote,
  MatchOutcome,
  MatchPort,
  MatchRequest,
} from "./ports";

export class FakeMatchPort implements MatchPort {
  readonly asked: MatchRequest[] = [];
  readonly learned: MatchLearnRequest[] = [];

  /**
   * `records`: record ids by the `sku` that matches them exactly. `unsure`: by sku, the records a
   * person chooses from (id → label).
   */
  constructor(
    readonly records: Readonly<Record<string, string>> = {},
    readonly fail?: string,
    readonly unsure: Readonly<Record<string, Readonly<Record<string, string>>>> = {},
  ) {}

  async match(request: MatchRequest): Promise<MatchOutcome> {
    this.asked.push(request);
    if (this.fail) return { kind: "failed", error: this.fail };
    const raw = request.input as { items?: unknown } | null;
    const list = Array.isArray(raw?.items) ? raw.items : [raw];
    const notes: MatchNote[] = [];
    const items: MatchItem[] = list.map((item) => {
      const sku = (item as { sku?: unknown } | null)?.sku;
      const key = typeof sku === "string" ? sku : "";
      const matched = this.records[key] ?? null;
      const choices = this.unsure[key] ?? {};
      notes.push({ sources: matched ? [`raw-${key}`] : [], labels: { ...choices } });
      return {
        item,
        matched,
        how: matched ? ("exact" as const) : null,
        confidence: matched ? 100 : null,
        isNew: false,
        unsure: !matched && Object.keys(choices).length > 0,
        candidates: Object.keys(choices).map((record) => ({ record, confidence: 60 })),
      };
    });
    const matched = items.filter((i) => i.matched !== null).length;
    const unsure = items.filter((i) => i.unsure).length;
    return {
      kind: "done",
      output: { items, matched, unsure, anyUnsure: unsure > 0 },
      notes,
      profileName: "Vendor items",
    };
  }

  async learn(request: MatchLearnRequest): Promise<boolean> {
    this.learned.push(request);
    return true;
  }
}
