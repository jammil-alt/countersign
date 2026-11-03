import { describe, expect, it } from "vitest";
import { eventRunId, isUuid, RUN_ID_NAMESPACE, scheduleRunId, uuidv5, uuidv7 } from "./ids";

describe("uuidv7", () => {
  it("has version 7, the RFC variant and the timestamp first", () => {
    const id = uuidv7(0x0189_1234_5678, new Uint8Array(10).fill(0xff));
    expect(isUuid(id)).toBe(true);
    expect(id.startsWith("01891234-5678-7")).toBe(true);
    expect(id[19]).toMatch(/[89ab]/);
  });

  it("sorts by time", () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a < b).toBe(true);
    expect(uuidv7()).not.toBe(uuidv7());
  });
});

describe("uuidv5", () => {
  it("matches the RFC example", async () => {
    // The well-known DNS-namespace example.
    expect(await uuidv5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe(
      "2ed6657d-e927-568b-95e1-2665a8aea6a2",
    );
  });

  it("refuses a namespace that isn't a uuid", async () => {
    await expect(uuidv5("x", "nope")).rejects.toThrow(/Not a uuid/);
  });
});

describe("run ids", () => {
  it("are the same for the same event, agent and workflow", async () => {
    const input = { eventId: "e1", agentId: "a1", workflowSlug: "intake" };
    expect(await eventRunId(input)).toBe(await eventRunId({ ...input }));
    expect(await eventRunId(input)).not.toBe(await eventRunId({ ...input, workflowSlug: "other" }));
    expect((await eventRunId(input))[14]).toBe("5");
  });

  it("are the same for the same scheduled tick however it is written", async () => {
    const a = await scheduleRunId({
      agentId: "a",
      workflowSlug: "w",
      scheduledAt: "2026-11-03T07:00:00Z",
    });
    const b = await scheduleRunId({
      agentId: "a",
      workflowSlug: "w",
      scheduledAt: "2026-11-03T01:00:00-06:00",
    });
    expect(a).toBe(b);
    expect(isUuid(RUN_ID_NAMESPACE)).toBe(true);
    await expect(
      scheduleRunId({ agentId: "a", workflowSlug: "w", scheduledAt: "soon" }),
    ).rejects.toThrow();
  });
});
