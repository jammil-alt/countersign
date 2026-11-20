// Connectors C4: the contract of the Connectors routes (docs/connectors-plan.md §3, §7).

import { describe, expect, it } from "vitest";
import { allRoutes } from "./all-routes";
import {
  OpsConnectionChangeBody,
  connectorAccessRoutes as r,
  SetMezonasMayBody,
} from "./connector-access";
import { checkRouteContract, forbiddenPortalFields, routeFamily } from "./contract";

describe("connector access routes", () => {
  it("hold to the contract and are served with every other route", () => {
    expect(checkRouteContract(r)).toEqual([]);
    expect(checkRouteContract(allRoutes)).toEqual([]);
    for (const [name, route] of Object.entries(r)) {
      expect(allRoutes[name as keyof typeof allRoutes], name).toBe(route);
    }
  });

  it("let only a client admin change a connection or answer a request; any client user reads", () => {
    for (const route of [
      r.portalAllowForAgent,
      r.portalSetAccess,
      r.portalSetMezonasMay,
      r.portalApproveConnectionRequest,
      r.portalDeclineConnectionRequest,
    ]) {
      expect(routeFamily(route)).toBe("portal");
      expect(route.roles).toEqual(["client_admin"]);
    }
    for (const route of [r.portalConnectors, r.portalConnector, r.portalConnectionRequests]) {
      expect(route.roles).toEqual(["client_admin", "client_user"]);
      expect(forbiddenPortalFields(route.response)).toEqual([]);
    }
  });

  it("give the operator no route that sets Changes by Mezonas", () => {
    const ops = Object.values(allRoutes).filter((route) => routeFamily(route) === "ops");
    expect(ops.some((route) => /mezonas-may/.test(route.path))).toBe(false);
  });

  it("ask a reason for every change of ours, and something to change", () => {
    const base = { permissions: { create: "approval" } };
    expect(OpsConnectionChangeBody.safeParse(base).success).toBe(false);
    expect(OpsConnectionChangeBody.safeParse({ ...base, reason: " " }).success).toBe(false);
    expect(
      OpsConnectionChangeBody.safeParse({ ...base, reason: "Buyer creates bills" }).success,
    ).toBe(true);
    expect(OpsConnectionChangeBody.safeParse({ reason: "Nothing" }).success).toBe(false);
  });

  it("set Changes by Mezonas by choice and duration, Ask me each time clearing it", () => {
    expect(SetMezonasMayBody.parse({ choice: "needs" })).toEqual({
      choice: "needs",
      duration: "until_off",
    });
    expect(SetMezonasMayBody.safeParse({ choice: "ask" }).success).toBe(true);
    expect(SetMezonasMayBody.safeParse({ choice: "auto" }).success).toBe(false);
    expect(SetMezonasMayBody.safeParse({ choice: "any", duration: "7_days" }).success).toBe(false);
  });
});
