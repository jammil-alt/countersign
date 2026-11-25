// A fake Match port for tests (the step model, docs/step-model-plan.md §7): matches each input item
// by its `sku` against a fixed list, exact only, and records what it was asked. Stream D's engine
// takes its place outside tests.

import type { MatchItem, MatchOutcome, MatchPort, MatchRequest } from "./ports";

export class FakeMatchPort implements MatchPort {
  readonly asked: MatchRequest[] = [];

  /** Record ids by the `sku` that matches them exactly. */
  constructor(
    readonly records: Readonly<Record<string, string>> = {},
    readonly fail?: string,
  ) {}

  async match(request: MatchRequest): Promise<MatchOutcome> {
    this.asked.push(request);
    if (this.fail) return { kind: "failed", error: this.fail };
    const raw = request.input as { items?: unknown } | null;
    const list = Array.isArray(raw?.items) ? raw.items : [raw];
    const items: MatchItem[] = list.map((item) => {
      const sku = (item as { sku?: unknown } | null)?.sku;
      const matched = typeof sku === "string" ? (this.records[sku] ?? null) : null;
      return {
        item,
        matched,
        ...(matched ? { how: "exact" as const, confidence: 100 } : {}),
        isNew: false,
        unsure: false,
        candidates: [],
      };
    });
    const matched = items.filter((i) => i.matched !== null).length;
    return { kind: "done", output: { items, matched, unsure: 0, anyUnsure: false } };
  }
}
