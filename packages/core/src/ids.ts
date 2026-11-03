import { toHex, utf8, webCrypto } from "./runtime";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function format(bytes: Uint8Array): string {
  const h = toHex(bytes);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function parse(uuid: string): Uint8Array {
  if (!isUuid(uuid)) throw new Error(`Not a uuid: ${uuid}`);
  const hex = uuid.replace(/-/g, "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** RFC 9562 uuid v7: 48-bit Unix ms timestamp, then random bits. Sorts by creation time. */
export function uuidv7(now: number = Date.now(), random?: Uint8Array): string {
  const bytes = new Uint8Array(16);
  const rand = random ?? webCrypto().getRandomValues(new Uint8Array(10));
  if (rand.length < 10) throw new Error("uuidv7 needs 10 random bytes");
  let ts = Math.floor(now);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ts % 256;
    ts = Math.floor(ts / 256);
  }
  for (let i = 0; i < 10; i++) bytes[6 + i] = rand[i] as number;
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  return format(bytes);
}

/** RFC 9562 uuid v5 (SHA-1 of namespace + name): the same inputs always give the same id. */
export async function uuidv5(name: string, namespace: string): Promise<string> {
  const ns = parse(namespace);
  const nameBytes = utf8(name);
  const input = new Uint8Array(ns.length + nameBytes.length);
  input.set(ns);
  input.set(nameBytes, ns.length);
  const hash = new Uint8Array(await webCrypto().subtle.digest("SHA-1", input)).slice(0, 16);
  hash[6] = ((hash[6] as number) & 0x0f) | 0x50;
  hash[8] = ((hash[8] as number) & 0x3f) | 0x80;
  return format(hash);
}

/** Namespace for triggered run ids. Never change it: existing run ids are derived from it. */
export const RUN_ID_NAMESPACE = "6f1c2a52-8f0e-4d7b-9a35-3c1d8e7b2f40";

// DECISION: run ids are uuid v5 for triggered runs, so a re-dispatched event or a repeated cron
// tick derives the same id and Cloudflare refuses the second instance; manual, command and test
// runs get a fresh v7 (docs/plan.md §1.2 "Starting runs").
export async function eventRunId(input: {
  eventId: string;
  agentId: string;
  workflowSlug: string;
}): Promise<string> {
  return uuidv5(`event:${input.eventId}:${input.agentId}:${input.workflowSlug}`, RUN_ID_NAMESPACE);
}

/** `scheduledAt` is the tick the run is for (an ISO instant), not the time the cron ran. */
export async function scheduleRunId(input: {
  agentId: string;
  workflowSlug: string;
  scheduledAt: string;
}): Promise<string> {
  const at = new Date(input.scheduledAt);
  if (Number.isNaN(at.getTime())) throw new Error(`Invalid scheduledAt: ${input.scheduledAt}`);
  return uuidv5(
    `schedule:${input.agentId}:${input.workflowSlug}:${at.toISOString()}`,
    RUN_ID_NAMESPACE,
  );
}
