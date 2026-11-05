// The optional `bindingKey` hook (docs/plan.md §1.26): a connector may key its bindings by
// something in the input (a browser site), only within its own keys.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { bindingKeyFor, defineConnector, defineReadTool } from "./connector";

const read = defineReadTool({
  id: "sites.page.read",
  description: "Read a page",
  input: z.object({ site: z.string() }),
  output: z.object({ text: z.string() }),
  run: async () => ({ text: "" }),
});

function connector(bindingKey?: (input: unknown) => string | null) {
  return defineConnector({
    id: "sites",
    name: "Sites",
    description: "",
    icon: "sites",
    auth: "none",
    entities: [],
    tools: [read],
    ...(bindingKey ? { bindingKey } : {}),
  });
}

describe("bindingKeyFor", () => {
  it("is the connector id without the hook", () => {
    expect(bindingKeyFor(connector(), { site: "acme" })).toBe("sites");
  });

  it("uses the hook's key from the input", () => {
    const c = connector((input) => `sites:${(input as { site: string }).site}`);
    expect(bindingKeyFor(c, { site: "acme" })).toBe("sites:acme");
  });

  it("refuses a key outside the connector's own, a null key or a hook that throws", () => {
    expect(
      bindingKeyFor(
        connector(() => "qbo"),
        {},
      ),
    ).toBeNull();
    expect(
      bindingKeyFor(
        connector(() => "sitesx"),
        {},
      ),
    ).toBeNull();
    expect(
      bindingKeyFor(
        connector(() => null),
        {},
      ),
    ).toBeNull();
    expect(
      bindingKeyFor(
        connector(() => {
          throw new Error("no site");
        }),
        {},
      ),
    ).toBeNull();
  });
});
