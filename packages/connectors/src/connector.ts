import {
  ConnectorManifest,
  connectorPrefixes,
  type JsonObject,
  type PermissionMatrix,
  type ToolAmount,
  type ToolSpec,
  type Verb,
} from "@countersign/core";
import { z } from "zod";
import type { CredentialsAccessor } from "./credentials-accessor";
import type { Logger } from "./logger";
import type { MessagingServices } from "./messaging/services";
import type { TokenRefresher } from "./oauth/tokens";
import { manifestDefaultProblems } from "./permissions";
import type { VoiceServices } from "./voice/services";

/** Mirrors `connection.status` in packages/db. */
export type ConnectionStatus = "pending" | "connected" | "disconnected" | "error";

/**
 * What a connector sees of one client's connection. Plain data, not the database row, so the
 * framework needs no database: the caller (agents' runtime, apps/api) loads the row inside
 * `withTenant()` and passes this in.
 */
export interface ConnectionRef {
  id: string;
  tenantId: string;
  connector: string;
  status: ConnectionStatus;
  /** QBO realmId, Gmail address. */
  externalAccountId: string | null;
  config: JsonObject;
  /** The connection's matrix; its `scope` is passed through for the connector to enforce. */
  permissions: Partial<PermissionMatrix>;
}

/**
 * What a connector may ask of the platform beyond its credentials, for the call's one client
 * (apps/api provides them, scoped with withTenant). Each is optional: a connector that needs one
 * refuses to act without it rather than skip the check.
 */
export interface ConnectorServices {
  /** Contacts and consent, for connectors that text or message people (messaging/services.ts). */
  messaging?: MessagingServices;
  /** Contacts, consent and calls, for connectors that place or answer calls (voice/services.ts). */
  voice?: VoiceServices;
}

/** Everything a connector call runs with: one client, one connection. */
export interface ConnectionContext {
  tenantId: string;
  connection: ConnectionRef;
  /** Decrypted lazily, and writable so refreshed tokens are persisted. */
  credentials: CredentialsAccessor;
  logger: Logger;
  now: () => Date;
  services?: ConnectorServices;
}

export type ToolContext = ConnectionContext;

/** A write runs with the external action's idempotency key (`<run id>:<step id>:<index>`). */
export interface WriteContext extends ToolContext {
  idempotencyKey: string;
}

/** A read tool (`sideEffect: 'none'`). Input and output are validated around `run`. */
export interface ReadToolHandler {
  kind: "read";
  input: z.ZodType;
  output: z.ZodType;
  run(input: unknown, ctx: ToolContext): Promise<unknown>;
}

/**
 * A write to the client's system (`sideEffect: 'external'`). `before` reads the record's current
 * state (null when there is none, e.g. a create) so the inbox can show "now / after this change"
 * and `external_action.before` keeps it; `run` performs the write once.
 */
export interface WriteToolHandler {
  kind: "write";
  input: z.ZodType;
  output: z.ZodType;
  beforeSchema: z.ZodType;
  before(input: unknown, ctx: ToolContext): Promise<unknown>;
  run(input: unknown, ctx: WriteContext, before: unknown): Promise<unknown>;
}

export type ToolHandler = ReadToolHandler | WriteToolHandler;

/** A tool as a connector defines it: its spec (without `source`/`connector`) and handler. */
export interface ToolDefinition {
  spec: Omit<ToolSpec, "source" | "connector">;
  handler: ToolHandler;
}

function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
}

/**
 * Defines a read tool. The spec's JSON Schemas are generated from the Zod schemas, so the
 * Builder, the builder palette and the validator see exactly what the handler accepts.
 */
export function defineReadTool<I extends z.ZodType, O extends z.ZodType>(def: {
  id: string;
  description: string;
  summary?: string;
  input: I;
  output: O;
  run(input: z.output<I>, ctx: ToolContext): Promise<z.input<O>>;
}): ToolDefinition {
  return {
    spec: {
      id: def.id,
      description: def.description,
      input: jsonSchemaOf(def.input),
      output: jsonSchemaOf(def.output),
      sideEffect: "none",
      verb: "read",
      ...(def.summary === undefined ? {} : { summary: def.summary }),
    },
    handler: {
      kind: "read",
      input: def.input,
      output: def.output,
      run: (input, ctx) => def.run(input as z.output<I>, ctx),
    },
  };
}

/** Defines a write to the client's system: always `external`, so always behind the gate. */
export function defineWriteTool<
  I extends z.ZodType,
  O extends z.ZodType,
  B extends z.ZodType,
>(def: {
  id: string;
  description: string;
  verb: Exclude<Verb, "read">;
  summary?: string;
  /** Input fields that become instructions: fixed text in the step only (ToolSpec `fixedInputs`). */
  fixedInputs?: string[];
  /** Where the input carries money, for approver rules on an amount (docs/plan.md §1.20). */
  amount?: ToolAmount;
  input: I;
  output: O;
  /** The shape of the before snapshot; nullable is added (null = nothing there yet). */
  beforeSchema: B;
  before(input: z.output<I>, ctx: ToolContext): Promise<z.input<B> | null>;
  run(input: z.output<I>, ctx: WriteContext, before: z.output<B> | null): Promise<z.input<O>>;
}): ToolDefinition {
  return {
    spec: {
      id: def.id,
      description: def.description,
      input: jsonSchemaOf(def.input),
      output: jsonSchemaOf(def.output),
      sideEffect: "external",
      verb: def.verb,
      ...(def.summary === undefined ? {} : { summary: def.summary }),
      ...(def.fixedInputs?.length ? { fixedInputs: def.fixedInputs } : {}),
      ...(def.amount === undefined ? {} : { amount: def.amount }),
    },
    handler: {
      kind: "write",
      input: def.input,
      output: def.output,
      beforeSchema: def.beforeSchema.nullable(),
      before: (input, ctx) => def.before(input as z.output<I>, ctx),
      run: (input, ctx, before) => def.run(input as z.output<I>, ctx, before as z.output<B> | null),
    },
  };
}

export interface RawRecordInput {
  entityType: string;
  externalId: string;
  /** QBO SyncToken; null when the system has no versions. */
  externalVersion: string | null;
  payload: JsonObject;
  isDeleted?: boolean;
}

export interface SyncOptions {
  since?: Date;
  full?: boolean;
}

export interface AttachmentRef {
  externalId: string;
  filename: string;
  mime: string;
  size?: number;
}

/** Starting OAuth: the platform made and signed `state`; the connector builds the provider URL. */
export interface AuthorizeRequest {
  tenantId: string;
  userId: string;
  state: string;
  redirectUri: string;
}

export interface CallbackRequest {
  tenantId: string;
  userId: string;
  redirectUri: string;
}

/**
 * What a successful sign-in gives the platform. The connector never writes the connection: the
 * platform encrypts `credentials` and stores the row (connected_by = the client user).
 */
// DECISION: handleCallback returns a grant rather than a Connection (ARCHITECTURE §6.1 sketch), so
// connectors stay free of the database and the platform alone encrypts and stores credentials.
export interface ConnectionGrant {
  externalAccountId: string | null;
  credentials: JsonObject;
  config?: JsonObject;
}

/** ARCHITECTURE §6.1, with handlers for `manifest.tools`. Every hook beyond tools is optional. */
export interface Connector {
  manifest: ConnectorManifest;
  /** Handlers by tool id, one for each of `manifest.tools`. */
  tools: Readonly<Record<string, ToolHandler>>;
  authorize?(req: AuthorizeRequest): Promise<{ redirectUrl: string }>;
  handleCallback?(params: Record<string, string>, req: CallbackRequest): Promise<ConnectionGrant>;
  /**
   * Whether this deployment has what signing in needs (e.g. the OAuth client id and secret).
   * Absent means ready. The portal shows "not available yet" for a connector that isn't.
   */
  isConfigured?(): boolean;
  /** OAuth connectors: how to refresh tokens (see oauth/tokens.ts). */
  tokens?: TokenRefresher;
  /** Revoke the grant at the provider when the client disconnects. */
  revoke?(ctx: ConnectionContext): Promise<void>;
  sync?(ctx: ConnectionContext, opts: SyncOptions): AsyncIterable<RawRecordInput>;
  fetchAttachments?(
    ctx: ConnectionContext,
    entityType: string,
    externalId: string,
  ): Promise<AttachmentRef[]>;
  downloadAttachment?(
    ctx: ConnectionContext,
    ref: AttachmentRef,
  ): Promise<{ bytes: Uint8Array; mime: string; filename: string }>;
  verifyWebhook?(headers: Record<string, string>, body: Uint8Array): Promise<boolean>;
}

export class ConnectorDefinitionError extends Error {
  constructor(
    readonly connectorId: string,
    readonly problems: string[],
  ) {
    super(`connector ${connectorId}: ${problems.join("; ")}`);
    this.name = "ConnectorDefinitionError";
  }
}

/**
 * A write that may have happened: it was started, the provider takes no idempotency key, and no
 * record of it could be matched (a crash between the provider accepting it and us recording it).
 * A connector throws this on a re-run instead of writing again; the runtime fails the action with
 * this reason and asks the operator to check (packages/agents `executeAction`).
 */
export class UnconfirmedWriteError extends Error {
  constructor(
    /** What may have happened, for the operator's inbox ("The text to Pat Lee may have been sent"). */
    readonly title: string,
    why: string,
    /** What the operator needs to check it (who, from where, since when, what was found). */
    readonly details: JsonObject = {},
  ) {
    super(`${title}; check before trying again: ${why}`);
    this.name = "UnconfirmedWriteError";
  }
}

type ConnectorHooks = Omit<Connector, "manifest" | "tools">;

/**
 * Builds a connector from its manifest fields and tool definitions, filling each tool's `source`
 * and `connector`, and checks it: the manifest parses, tool ids start with `<connector>.`, and
 * the starting matrix is no looser than the platform defaults.
 */
export function defineConnector(
  def: Omit<ConnectorManifest, "tools"> & { tools: ToolDefinition[] } & ConnectorHooks,
): Connector {
  const {
    id,
    name,
    description,
    icon,
    auth,
    entities,
    defaultPermissions,
    events,
    sharedNamespaces,
    tools,
    ...hooks
  } = def;
  const problems: string[] = [];
  const specs: ToolSpec[] = tools.map((t) => ({
    ...t.spec,
    source: id,
    ...(t.spec.sideEffect === "external" ? { connector: id } : {}),
  }));
  const parsed = ConnectorManifest.safeParse({
    id,
    name,
    description,
    icon,
    auth,
    entities,
    tools: specs,
    ...(defaultPermissions === undefined ? {} : { defaultPermissions }),
    ...(events === undefined ? {} : { events }),
    ...(sharedNamespaces === undefined ? {} : { sharedNamespaces }),
  });
  if (!parsed.success) {
    problems.push(
      ...parsed.error.issues.map((i) => `${i.path.join(".") || "manifest"}: ${i.message}`),
    );
  }
  const handlers: Record<string, ToolHandler> = {};
  const prefixes = connectorPrefixes({ id, sharedNamespaces });
  for (const t of tools) {
    if (!prefixes.some((p) => t.spec.id.startsWith(p))) {
      problems.push(`tool ${t.spec.id} must start with "${id}."`);
    }
    // DECISION: connector tools are reads or writes to the client's system; `internal` writes
    // (the platform's own records) belong to platform and pack tools, not connectors.
    if (t.spec.sideEffect === "internal") {
      problems.push(`tool ${t.spec.id}: connector tools are 'none' or 'external'`);
    }
    if ((t.spec.sideEffect === "external") !== (t.handler.kind === "write")) {
      problems.push(`tool ${t.spec.id}: handler kind ${t.handler.kind} does not match its spec`);
    }
    handlers[t.spec.id] = t.handler;
  }
  if (auth === "oauth2" && (!hooks.authorize || !hooks.handleCallback)) {
    problems.push("oauth2 connectors need authorize and handleCallback");
  }
  problems.push(...manifestDefaultProblems({ defaultPermissions }));
  if (problems.length > 0 || !parsed.success) throw new ConnectorDefinitionError(id, problems);
  return { ...hooks, manifest: parsed.data, tools: handlers };
}
