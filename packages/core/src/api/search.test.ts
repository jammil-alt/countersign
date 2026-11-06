import { describe, expect, it } from "vitest";
import { z } from "zod";
import { routes } from "./routes";
import {
  interleave,
  likeContaining,
  readSearchText,
  searchAmountOf,
  squeezeSpaces,
} from "./search";

describe("search text", () => {
  it("reads amounts the way people type them", () => {
    expect(searchAmountOf("$1,234.50")).toBe("1234.50");
    expect(searchAmountOf("1234.5")).toBe("1234.5");
    expect(searchAmountOf(" $ 5000 ")).toBe("5000");
    expect(searchAmountOf("12")).toBe("12");
    for (const no of ["", "$", "abc", "1.2.3", "1.23456", "-5", "12 34", "5,000 bills", ".5"]) {
      expect(searchAmountOf(no), no).toBeNull();
    }
  });

  it("reads a run's short id", () => {
    expect(readSearchText("R-1A2B3C").runTail).toBe("1a2b3c");
    expect(readSearchText("1a2b3c").runTail).toBe("1a2b3c");
    expect(readSearchText("Iris").runTail).toBeNull();
  });

  it("squeezes spaces without a regex, and quickly on long input", () => {
    expect(squeezeSpaces("  Oak \t\n board  ")).toBe("Oak board");
    const long = `${" a".repeat(50_000)}!`;
    const started = Date.now();
    expect(squeezeSpaces(long).length).toBe(100_000);
    expect(searchAmountOf(`${"1,".repeat(50_000)}x`)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("takes LIKE's own characters literally", () => {
    expect(likeContaining("50%_off\\")).toBe("%50\\%\\_off\\\\%");
  });

  it("takes from each kind in turn", () => {
    expect(interleave([[1, 2, 3, 4], [10], [20, 21]], 5)).toEqual([1, 10, 20, 2, 21]);
    expect(interleave([[], []], 5)).toEqual([]);
  });
});

describe("search routes", () => {
  /** Every property name in a response schema. */
  const names = (schema: z.ZodType) => {
    const found = new Set<string>();
    const visit = (node: unknown) => {
      if (Array.isArray(node)) node.forEach(visit);
      else if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) {
          if (k === "properties" && v && typeof v === "object") {
            for (const p of Object.keys(v)) found.add(p);
          }
          visit(v);
        }
      }
    };
    visit(z.toJSONSchema(schema, { io: "output", unrepresentable: "any" }));
    return [...found];
  };

  it("gives the portal no templates, clients, notes or costs", () => {
    const fields = names(routes.portalSearch.response);
    for (const banned of [
      "template",
      "templateId",
      "client",
      "tenantId",
      "notes",
      "note",
      "costUsd",
    ]) {
      expect(fields).not.toContain(banned);
    }
    expect(routes.portalSearch.roles).toEqual(["client_admin", "client_user"]);
  });

  it("names the client of every back-office hit", () => {
    const fields = names(routes.opsSearch.response);
    expect(fields).toContain("client");
  });
});
