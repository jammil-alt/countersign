// §1.73: a pack report's query parameters reach the pack only as its own schema parses them; the
// session's `client` never does, and a report without a schema gets none. §1.162: each business
// area names the connections it works through.

import { routes } from "@countersign/core";
import { SiteRangeQuery } from "@countersign/pack-marketing";
import { describe, expect, it } from "vitest";
import { HttpError } from "../http";
import { DEPLOYMENT_PACKS } from "../packs";
import { deploymentConnectors } from "../platform";
import { reportQuery } from "./packs";

const SITE = "0195f3c0-0000-7000-8000-000000000001";

describe("pack report query parameters", () => {
  it("are parsed by the pack's schema, without the session's client", () => {
    expect(
      reportQuery({ query: SiteRangeQuery }, { client: SITE, site: SITE, from: "2026-11-01" }),
    ).toEqual({ site: SITE, from: "2026-11-01" });
    expect(reportQuery({ query: SiteRangeQuery }, undefined)).toEqual({});
  });

  it("are refused with a 400 when they don't parse", () => {
    const bad = (raw: Record<string, string>) => {
      try {
        reportQuery({ query: SiteRangeQuery }, raw);
      } catch (error) {
        return error instanceof HttpError ? [error.status, error.code] : error;
      }
      return "passed";
    };
    expect(bad({ from: "yesterday" })).toEqual([400, "invalid_query"]);
    expect(bad({ from: "2026-11-05", to: "2026-11-01" })).toEqual([400, "invalid_query"]);
    expect(bad({ unknown: "1" })).toEqual([400, "invalid_query"]);
  });

  it("are dropped for a report without a schema (Materials' reports)", () => {
    expect(reportQuery({}, { client: SITE, anything: "1" })).toEqual({});
  });

  it("are declared on every report route, as strings with plain names", () => {
    for (const route of [
      routes.portalPackReport,
      routes.portalPackReportCsv,
      routes.portalPackReportItem,
      routes.opsClientPackReport,
      routes.opsClientPackReportCsv,
      routes.opsClientPackReportItem,
    ]) {
      expect(route.query?.safeParse({ site: SITE, from: "2026-11-01" }).success).toBe(true);
      expect(route.query?.safeParse({ "bad name": "x" }).success).toBe(false);
    }
  });
});

// §1.162: the client page's Areas tab shows each area's connections with the client's status, so
// every connector an area names must be one the deployment registers.
describe("the connections each business area works through", () => {
  it("name only registered connectors, and every area says what it needs", () => {
    const connectors = new Set(deploymentConnectors({}, false).map((c) => c.manifest.id));
    for (const pack of DEPLOYMENT_PACKS) {
      const needs = pack.manifest.connections ?? [];
      expect(needs.length, pack.manifest.id).toBeGreaterThan(0);
      for (const need of needs) {
        for (const id of need.connectors)
          expect(connectors, `${pack.manifest.id}: ${id}`).toContain(id);
      }
    }
  });
});
