// DQ-002 (`data.reshape#nearestWithin`): Reshape data picks the item of a list nearest a point,
// within a distance in metres, or gives none with the reason. Great-circle distance, no model.

import { describe, expect, it } from "vitest";
import type { JsonSchema } from "../schemas/common";
import {
  EARTH_RADIUS_METRES,
  evaluateReshape,
  greatCircleMetres,
  type NearestWithin,
  type ReshapeExpr,
  ReshapeExpr as ReshapeExprSchema,
  reshapeProblems,
} from "./reshape";

/** One metre of latitude, in degrees, on the sphere distances are measured on. */
const DEG_PER_METRE = 180 / (Math.PI * EARTH_RADIUS_METRES);

// The photo's point (Get document's latitude and longitude), and projects north and south of it.
const POINT = { latitude: 30.267153, longitude: -97.743057 };
const north = (m: number) => POINT.latitude + m * DEG_PER_METRE;
const A = { name: "A", lat: north(100), lng: POINT.longitude };
const B = { name: "B", lat: north(-400), lng: POINT.longitude };

const pick = (max: number | string = 250): ReshapeExpr => ({
  nearestWithin: {
    latitude: { input: "photo.latitude" },
    longitude: { input: "photo.longitude" },
    list: { input: "projects" },
    latitudeField: "lat",
    longitudeField: "lng",
    maxMetres: { value: max },
  },
});

function nearest(input: unknown, from: ReshapeExpr = pick()): NearestWithin {
  const r = evaluateReshape({ fields: [{ name: "project", schema: {}, from }] }, input, {
    today: "2026-11-23",
  });
  expect(r.problems).toEqual([]);
  return r.output.project as NearestWithin;
}

const photo = { latitude: POINT.latitude, longitude: POINT.longitude };

describe("Reshape data: nearest within a distance", () => {
  it("picks the project 100 m away over one 400 m away, with a 250 m radius", () => {
    const got = nearest({ photo, projects: [B, A] });
    expect(got.item).toEqual(A);
    expect(got.reason).toBeNull();
    expect(Math.abs((got.distanceMetres ?? 0) - 100)).toBeLessThan(0.01);
    expect(got.skipped).toEqual([]);
  });

  it("gives none with a 50 m radius: nothing within the distance", () => {
    expect(nearest({ photo, projects: [A, B] }, pick(50))).toEqual({
      item: null,
      distanceMetres: null,
      reason: "nothing_within",
      skipped: [],
    });
  });

  it("gives none for a missing or empty point: no point given, and no error", () => {
    for (const p of [undefined, {}, { latitude: null, longitude: null }, { latitude: "" }]) {
      expect(nearest({ photo: p, projects: [A, B] })).toMatchObject({
        item: null,
        reason: "no_point",
      });
    }
    // A point that isn't degrees in range is no point either.
    expect(nearest({ photo: { latitude: 91, longitude: 0 }, projects: [A] }).reason).toBe(
      "no_point",
    );
  });

  it("gives none for two projects at the same distance: a tie, never list order", () => {
    const C = { name: "C", lat: north(-100), lng: POINT.longitude };
    expect(nearest({ photo, projects: [A, C, B] })).toMatchObject({ item: null, reason: "tie" });
    // Under a metre apart is the same distance; a metre or more is not.
    const D = { name: "D", lat: north(100.5), lng: POINT.longitude };
    expect(nearest({ photo, projects: [D, A] }).reason).toBe("tie");
    const E = { name: "E", lat: north(102), lng: POINT.longitude };
    expect(nearest({ photo, projects: [E, A] }).item).toEqual(A);
  });

  it("skips and lists a project with missing or out-of-range coordinates, and compares the rest", () => {
    const missing = { name: "M", lng: POINT.longitude };
    const outOfRange = { name: "O", lat: 120, lng: POINT.longitude };
    const words = { name: "W", lat: "north", lng: POINT.longitude };
    const got = nearest({ photo, projects: [missing, B, outOfRange, A, words] });
    expect(got.item).toEqual(A);
    expect(got.skipped).toEqual([
      { index: 0, reason: "missing", item: missing },
      { index: 2, reason: "invalid", item: outOfRange },
      { index: 4, reason: "invalid", item: words },
    ]);
  });

  it("reads coordinates written as text, and a radius from the input", () => {
    const asText = { name: "T", lat: String(A.lat), lng: String(A.lng) };
    const from: ReshapeExpr = {
      nearestWithin: {
        latitude: { input: "photo.latitude" },
        longitude: { input: "photo.longitude" },
        list: { input: "projects" },
        latitudeField: "where.lat",
        longitudeField: "where.lng",
        maxMetres: { input: "radius" },
      },
    };
    const got = nearest({ photo, radius: "250", projects: [{ where: asText }] }, from);
    expect(got.item).toEqual({ where: asText });
    // No projects at all is nothing within the distance.
    expect(nearest({ photo, radius: 250 }, from).reason).toBe("nothing_within");
  });

  it("refuses a radius that isn't a distance, and a list that isn't one", () => {
    const r = evaluateReshape(
      { fields: [{ name: "project", schema: {}, from: pick("far") }] },
      { photo, projects: [A] },
      { today: "2026-11-23" },
    );
    expect(r.problems.map((p) => p.message)).toEqual([
      expect.stringContaining("isn't a distance in metres above 0"),
    ]);
    const notList = evaluateReshape(
      { fields: [{ name: "project", schema: {}, from: pick() }] },
      { photo, projects: "A" },
      { today: "2026-11-23" },
    );
    expect(notList.problems.map((p) => p.message)).toEqual([
      expect.stringContaining("isn't a list"),
    ]);
  });

  it("measures great-circle distance within 1 m of a reference, up to 10 km", () => {
    // The reference: the Vincenty formula on the same sphere (atan2 of the central angle).
    const reference = (
      a: { latitude: number; longitude: number },
      b: { latitude: number; longitude: number },
    ) => {
      const r = Math.PI / 180;
      const [p1, p2, dl] = [a.latitude * r, b.latitude * r, (b.longitude - a.longitude) * r];
      const y = Math.hypot(
        Math.cos(p2) * Math.sin(dl),
        Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl),
      );
      const x = Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(dl);
      return EARTH_RADIUS_METRES * Math.atan2(y, x);
    };
    for (const from of [
      POINT,
      { latitude: -33.8688, longitude: 151.2093 },
      { latitude: 64.1, longitude: -21.9 },
    ]) {
      for (const metres of [1, 10, 100, 250, 1000, 5000, 10_000]) {
        for (const bearing of [0, 37, 90, 145, 230, 300]) {
          // A destination along the bearing on the sphere.
          const r = Math.PI / 180;
          const d = metres / EARTH_RADIUS_METRES;
          const p1 = from.latitude * r;
          const l1 = from.longitude * r;
          const b = bearing * r;
          const p2 = Math.asin(
            Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b),
          );
          const l2 =
            l1 +
            Math.atan2(
              Math.sin(b) * Math.sin(d) * Math.cos(p1),
              Math.cos(d) - Math.sin(p1) * Math.sin(p2),
            );
          const to = { latitude: p2 / r, longitude: l2 / r };
          const got = greatCircleMetres(from, to);
          expect(Math.abs(got - reference(from, to))).toBeLessThan(1);
          expect(Math.abs(got - metres)).toBeLessThan(1);
        }
      }
    }
    // A degree of latitude along a meridian: R·π/180.
    expect(
      greatCircleMetres({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 }),
    ).toBeCloseTo((EARTH_RADIUS_METRES * Math.PI) / 180, 6);
  });

  it("gives the same output for the same input, every time", () => {
    const input = { photo, projects: [B, A, { name: "M" }] };
    const once = JSON.stringify(nearest(input));
    for (let i = 0; i < 5; i++) expect(JSON.stringify(nearest(input))).toBe(once);
  });

  it("parses as an expression and types against the step's input", () => {
    expect(ReshapeExprSchema.safeParse(pick()).success).toBe(true);
    expect(
      ReshapeExprSchema.safeParse({
        nearestWithin: { ...(pick() as { nearestWithin: object }).nearestWithin, extra: 1 },
      }).success,
    ).toBe(false);
    const input: JsonSchema = {
      type: "object",
      properties: {
        photo: {
          type: "object",
          properties: { latitude: { type: "number" }, longitude: { type: "number" } },
        },
        projects: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              lat: { type: "number" },
              lng: { type: "number" },
            },
          },
        },
      },
    };
    const mapping = (from: ReshapeExpr, schema: JsonSchema = {}) => ({
      fields: [{ name: "project", schema, from }],
    });
    expect(reshapeProblems(mapping(pick()), input)).toEqual([]);
    const wrongField: ReshapeExpr = {
      nearestWithin: {
        ...(
          pick() as {
            nearestWithin: Extract<ReshapeExpr, { nearestWithin: unknown }>["nearestWithin"];
          }
        ).nearestWithin,
        latitudeField: "latitude",
      },
    };
    expect(reshapeProblems(mapping(wrongField), input).map((p) => p.message)).toEqual([
      expect.stringContaining("reads latitude of each item in"),
    ]);
    // It gives a record; a field that takes text doesn't fit it.
    expect(reshapeProblems(mapping(pick(), { type: "string" }), input)).not.toEqual([]);
  });
});
