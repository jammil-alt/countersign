import { toHex, utf8, webCrypto } from "./runtime";

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit, no whitespace, `undefined` properties
 * omitted (as JSON.stringify does), -0 written as 0. Equal values always give equal strings, so
 * hashes of bundles and definitions are stable across runtimes and key orders.
 */
export function canonicalJson(value: unknown): string {
  return write(value, "$");
}

function write(value: unknown, at: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new Error(`canonicalJson: non-finite number at ${at}`);
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((v, i) => (v === undefined ? "null" : write(v, `${at}[${i}]`))).join(",")}]`;
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${write(obj[k], `${at}.${k}`)}`).join(",")}}`;
    }
    default:
      throw new Error(`canonicalJson: unsupported ${typeof value} at ${at}`);
  }
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? utf8(input) : input;
  return toHex(new Uint8Array(await webCrypto().subtle.digest("SHA-256", bytes)));
}

/** sha256 of the canonical JSON of a value: `agent_version.bundle_hash`, `skill_version.definition_hash`. */
export function hashJson(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value));
}

/** `bundle_hash` (ARCHITECTURE §9.3). Hash the parsed bundle so defaults don't change the hash. */
export function bundleHash(bundle: unknown): Promise<string> {
  return hashJson(bundle);
}
