import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildPath,
  checkRouteContract,
  defineRoute,
  forbiddenPortalFields,
  routeFamily,
} from "./contract";
import { routes } from "./routes";

describe("route contract", () => {
  it("holds for the declared routes", () => {
    expect(checkRouteContract(routes)).toEqual([]);
  });

  it("refuses an /api/ops route open to client roles", () => {
    const bad = defineRoute({
      method: "GET",
      path: "/api/ops/clients",
      auth: "session",
      roles: ["operator", "client_admin"],
      summary: "",
      response: z.object({}),
    });
    expect(checkRouteContract({ bad })).toEqual([
      "bad (GET /api/ops/clients): /api/ops routes are operator-only",
    ]);
  });

  it("refuses a portal response carrying bundles, instructions, prompts or cost", () => {
    const leaky = defineRoute({
      method: "GET",
      path: "/api/runs/:id",
      auth: "session",
      roles: ["client_admin", "client_user"],
      summary: "",
      response: z.object({
        id: z.string(),
        steps: z.array(z.object({ summary: z.string(), costUsd: z.string() })),
        agent: z.object({ bundle: z.unknown(), instructions: z.string() }),
      }),
    });
    expect(forbiddenPortalFields(leaky.response).sort()).toEqual([
      "bundle",
      "costUsd",
      "instructions",
    ]);
    expect(checkRouteContract({ leaky })).toHaveLength(1);
    // Business figures such as a landed cost are not model cost.
    expect(forbiddenPortalFields(z.object({ landedCost: z.string() }))).toEqual([]);
  });

  it("knows the families and fills path parameters", () => {
    expect(routeFamily({ path: "/api/ops/runs" })).toBe("ops");
    expect(routeFamily({ path: "/api/runs" })).toBe("portal");
    expect(buildPath("/api/ops/agents/:id/versions/:vid", { id: "a b", vid: 3 })).toBe(
      "/api/ops/agents/a%20b/versions/3",
    );
    expect(() => buildPath("/api/x/:id")).toThrow(/:id/);
  });
});
