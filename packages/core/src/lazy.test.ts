import { describe, expect, it } from "vitest";
import { z } from "zod";
import { copyLazy, defineLazy, lazy, lazyObject, lazyObjects, lazyParse } from "./lazy";

describe("lazyObject", () => {
  it("computes a lazy value on first read, once, in the same key order", () => {
    let calls = 0;
    const obj = lazyObject({
      a: 1,
      b: lazy(() => {
        calls += 1;
        return { deep: [1, 2] };
      }),
      c: "x",
    });
    expect(calls).toBe(0);
    expect(Object.keys(obj)).toEqual(["a", "b", "c"]);
    expect(JSON.stringify(obj)).toBe('{"a":1,"b":{"deep":[1,2]},"c":"x"}');
    expect(obj.b).toBe(obj.b);
    expect(calls).toBe(1);
    expect(Object.getOwnPropertyDescriptor(obj, "b")).toEqual({
      value: { deep: [1, 2] },
      writable: true,
      enumerable: true,
      configurable: true,
    });
  });

  it("matches the eager object under spreads and equality", () => {
    const eager = { a: 1, b: { n: 2 }, c: [3] };
    const make = () => lazyObject({ a: 1, b: lazy(() => ({ n: 2 })), c: lazy(() => [3]) });
    expect({ ...make() }).toEqual(eager);
    expect(make()).toStrictEqual(eager);
  });

  it("takes an assignment before the first read without computing", () => {
    let calls = 0;
    const obj = lazyObject({
      a: lazy(() => {
        calls += 1;
        return 1;
      }),
    });
    obj.a = 5;
    expect(obj.a).toBe(5);
    expect(calls).toBe(0);
  });

  it("computes again after a throw", () => {
    let calls = 0;
    const obj = {} as { a: number };
    defineLazy(obj, "a", () => {
      calls += 1;
      if (calls === 1) throw new Error("first");
      return 2;
    });
    expect(() => obj.a).toThrow("first");
    expect(obj.a).toBe(2);
  });

  it("works on a frozen object", () => {
    let calls = 0;
    const obj = Object.freeze(
      lazyObject({
        a: lazy(() => {
          calls += 1;
          return [1];
        }),
      }),
    );
    expect(obj.a).toBe(obj.a);
    expect(calls).toBe(1);
  });
});

describe("copyLazy", () => {
  it("copies getters without reading them, and shares their one computation", () => {
    let calls = 0;
    const obj = lazyObject({
      a: 1,
      b: lazy(() => {
        calls += 1;
        return { n: calls };
      }),
    });
    const copy = { ...copyLazy(obj), c: 3 };
    expect(calls).toBe(1); // the spread read it
    const kept = copyLazy(obj);
    expect(Object.keys(kept)).toEqual(["a", "b"]);
    expect(kept.b).toBe(obj.b);
    expect(copy.b).toBe(obj.b);
    expect(calls).toBe(1);
  });

  it("does not compute until a copy is read", () => {
    let calls = 0;
    const obj = lazyObject({
      b: lazy(() => {
        calls += 1;
        return 1;
      }),
    });
    const copy = Object.assign(copyLazy(obj), { c: 2 });
    expect(Object.keys(copy)).toEqual(["b", "c"]);
    expect(calls).toBe(0);
    expect(copy.b).toBe(1);
    expect(obj.b).toBe(1);
    expect(calls).toBe(1);
  });
});

describe("lazyObjects", () => {
  it("leaves getters already there unread", () => {
    let calls = 0;
    const done = lazyObject({
      a: lazy(() => {
        calls += 1;
        return 1;
      }),
    });
    const list = lazyObjects([done, { a: lazy(() => 2) }]);
    expect(calls).toBe(0);
    expect(list.map((x) => x.a)).toEqual([1, 2]);
  });
});

describe("lazyParse", () => {
  const Schema = z
    .object({
      id: z.string(),
      tags: z.array(z.string()).default([]),
      note: z.string().optional(),
    })
    .superRefine((v, ctx) => {
      if (v.id === "bad") ctx.addIssue({ code: "custom", message: "bad id" });
    });

  it("parses on the first read, into the parsed object's keys and values", () => {
    let calls = 0;
    const obj = lazyParse(Schema, () => {
      calls += 1;
      return { id: "a", extra: 1 };
    });
    expect(calls).toBe(0);
    expect(obj.id).toBe("a");
    expect(calls).toBe(1);
    const eager = Schema.parse({ id: "a", extra: 1 });
    expect(Object.keys(obj)).toEqual(Object.keys(eager));
    expect(JSON.stringify(obj)).toBe(JSON.stringify(eager));
    expect(obj).toStrictEqual(eager);
    expect(obj.tags).toBe(obj.tags);
    expect(calls).toBe(1);
  });

  it("throws the parse error to the read, and again on the next", () => {
    const obj = lazyParse(Schema, () => ({ id: "bad" }));
    expect(() => obj.id).toThrow("bad id");
    expect(() => obj.tags).toThrow("bad id");
  });
});
