// Harness smoke check for the platform QA repros: the throwaway database and the app come up.
import { afterAll, describe, expect, it } from "vitest";
import { createApiHarness } from "../api.test-helper";

const h = await createApiHarness();
afterAll(() => h?.close());

describe("qa harness", () => {
  it("QA-SMOKE: builds the API over a throwaway database", () => {
    expect(h).not.toBeNull();
  });
});
