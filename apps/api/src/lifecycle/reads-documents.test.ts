// UI cleanup: the portal's agent page offers upload to an agent that starts from documents (an
// enabled workflow with a `document.*` event trigger), and to no other.
import type { AgentBundle } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { readsDocuments } from "./runs";

function bundle(workflows: { on: Record<string, unknown>; enabled?: boolean }[]): AgentBundle {
  return {
    workflows: workflows.map((w, i) => ({
      slug: `w${i}`,
      name: `Workflow ${i}`,
      enabled: w.enabled ?? true,
      workflow: { trigger: { id: `t${i}`, on: w.on } },
    })),
  } as unknown as AgentBundle;
}

describe("readsDocuments", () => {
  it("is true for an enabled workflow started by a document event", () => {
    expect(readsDocuments(bundle([{ on: { type: "event", event: "document.extracted" } }]))).toBe(
      true,
    );
    expect(
      readsDocuments(
        bundle([
          { on: { type: "manual", input: {} } },
          { on: { type: "event", event: "document.received" } },
        ]),
      ),
    ).toBe(true);
  });

  it("is false for other triggers, a disabled workflow, or no live bundle", () => {
    expect(readsDocuments(bundle([{ on: { type: "manual", input: {} } }]))).toBe(false);
    expect(readsDocuments(bundle([{ on: { type: "event", event: "run.finished" } }]))).toBe(false);
    expect(
      readsDocuments(
        bundle([{ on: { type: "event", event: "document.extracted" }, enabled: false }]),
      ),
    ).toBe(false);
    expect(readsDocuments(null)).toBe(false);
  });
});
