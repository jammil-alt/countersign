import { describe, expect, it } from "vitest";
import { bundleHash, canonicalJson, hashJson, sha256Hex } from "./canonical";
import { AgentBundle } from "./schemas/agent";
import { bundle, bundleInput } from "./testing/fixtures";

describe("canonicalJson", () => {
  it("sorts keys at every level and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,1]},"b":1}',
    );
  });

  it("omits undefined properties and writes -0 as 0", () => {
    expect(canonicalJson({ a: undefined, b: -0, c: [undefined] })).toBe('{"b":0,"c":[null]}');
  });

  it("refuses values JSON can't hold", () => {
    expect(() => canonicalJson({ x: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ x: Number.POSITIVE_INFINITY })).toThrow(/non-finite/);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(/unsupported/);
  });

  it("escapes strings as JSON does", () => {
    expect(canonicalJson({ 'k"': 'v\n"é' })).toBe('{"k\\"":"v\\n\\"é"}');
  });
});

describe("hashing", () => {
  it("is sha256 hex", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(await hashJson({})).toBe(
      "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    );
  });

  it("doesn't depend on key order", async () => {
    expect(await hashJson({ a: 1, b: { c: 2, d: 3 } })).toBe(
      await hashJson({ b: { d: 3, c: 2 }, a: 1 }),
    );
  });

  it("gives a parsed bundle the same hash however its input was written", async () => {
    const input = bundleInput();
    const reordered = JSON.parse(JSON.stringify(input, Object.keys(input).reverse()));
    const a = await bundleHash(AgentBundle.parse(input));
    const b = await bundleHash(AgentBundle.parse({ ...reordered, ...input }));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when anything in the bundle changes", async () => {
    const a = bundle();
    const b = bundle();
    b.definition.instructions = "Work quickly.";
    expect(await bundleHash(a)).not.toBe(await bundleHash(b));
  });
});
