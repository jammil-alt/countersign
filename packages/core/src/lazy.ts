// Values computed on first read: a tool spec's JSON Schemas, a skill's input and output, a pack's
// parsed manifest. The Worker evaluates every module before its first request, under a startup
// CPU limit, so work done at import is work every isolate pays for before it can serve anything.

// DECISION: (Worker startup, docs/plan.md §1.86) a definition that is expensive to build (a Zod
// schema turned into JSON Schema, a manifest parsed) is built on first read and kept, through an
// enumerable getter in the same place as the eager property, not by making callers ask for it. So
// JSON.stringify, spreads, Object.keys, structuredClone and deep equality see the same keys, in
// the same order, with the same values as before; only the moment the value is computed moves.

import type { z } from "zod";

const LAZY: unique symbol = Symbol("lazy");

interface Lazy<T> {
  readonly [LAZY]: () => T;
}

function isLazy(value: unknown): value is Lazy<unknown> {
  return typeof value === "object" && value !== null && LAZY in value;
}

/**
 * A value `lazyObject` computes on first read. Typed as the value, so an object literal keeps its
 * type; it means nothing outside `lazyObject`.
 */
export function lazy<T>(compute: () => T): T {
  return { [LAZY]: compute } satisfies Lazy<T> as unknown as T;
}

/** Makes `obj[key]` a plain data property holding `value`, where the object allows it. */
function settle(obj: object, key: PropertyKey, value: unknown): void {
  const own = Object.getOwnPropertyDescriptor(obj, key);
  if (own ? own.configurable : Object.isExtensible(obj)) {
    Object.defineProperty(obj, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
}

/**
 * Defines `obj[key]` as an enumerable, memoised getter (in place, so the key keeps its position).
 * The first read computes the value once, even through a copy of the descriptor, and turns the
 * property into a plain, writable data property; an assignment before that replaces it.
 */
export function defineLazy<T extends object, K extends PropertyKey>(
  obj: T,
  key: K,
  compute: () => unknown,
): void {
  let computed = false;
  let value: unknown;
  Object.defineProperty(obj, key, {
    enumerable: true,
    configurable: true,
    get(this: object) {
      if (!computed) {
        value = compute();
        computed = true;
      }
      settle(this, key, value);
      return value;
    },
    set(this: object, next: unknown) {
      settle(this, key, next);
    },
  });
}

/**
 * Turns each `lazy(...)` value of `obj` into a memoised getter (`defineLazy`); returns `obj`.
 * Getters it already has are left alone, unread.
 */
export function lazyObject<T extends object>(obj: T): T {
  for (const key of Object.keys(obj)) {
    const value = Object.getOwnPropertyDescriptor(obj, key)?.value;
    if (isLazy(value)) defineLazy(obj, key, value[LAZY]);
  }
  return obj;
}

/** `lazyObject` for each item of a list, e.g. a module's skill definitions; returns the list. */
export function lazyObjects<T extends object>(items: T[]): T[] {
  for (const item of items) lazyObject(item);
  return items;
}

/**
 * A shallow copy that keeps lazy getters (`defineLazy`) as getters, where a spread would read, and
 * so compute, each one. Own enumerable string keys only, in order, like a spread; any other
 * property is read, as a spread reads it.
 */
export function copyLazy<T extends object>(obj: T): T {
  const out = {} as T;
  for (const key of Object.keys(obj)) {
    const d = Object.getOwnPropertyDescriptor(obj, key) as PropertyDescriptor;
    if (d.get && d.set) {
      Object.defineProperty(out, key, {
        get: d.get,
        set: d.set,
        enumerable: true,
        configurable: true,
      });
    } else {
      (out as Record<string, unknown>)[key] = (obj as Record<string, unknown>)[key];
    }
  }
  return out;
}

/**
 * `schema.parse(input())`, made on the first read of any of its keys, e.g. a pack's manifest. Until
 * then the object has the schema's keys; that read puts the parsed object's own keys, values and
 * order in their place (a key the parse leaves out goes), and a parse error is thrown to it.
 */
export function lazyParse<S extends z.ZodObject>(schema: S, input: () => unknown): z.output<S> {
  const obj: Record<string, unknown> = {};
  const keys = Object.keys(schema.shape);
  let parsed = false;
  const materialise = () => {
    if (parsed) return;
    const value = schema.parse(input()) as Record<string, unknown>;
    parsed = true;
    for (const key of keys) delete obj[key];
    for (const key of Object.keys(value)) obj[key] = value[key];
  };
  for (const key of keys) {
    Object.defineProperty(obj, key, {
      enumerable: true,
      configurable: true,
      get() {
        materialise();
        return obj[key];
      },
      set(next: unknown) {
        materialise();
        obj[key] = next;
      },
    });
  }
  return obj as z.output<S>;
}

/** A function that runs `compute` on its first call and returns that value from then on. */
export function once<T>(compute: () => T): () => T {
  let computed = false;
  let value: T;
  return () => {
    if (!computed) {
      value = compute();
      computed = true;
    }
    return value;
  };
}
