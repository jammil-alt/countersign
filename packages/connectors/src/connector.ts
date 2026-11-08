import {
  ConnectorManifest,
  connectorPrefixes,
  type JsonObject,
  type PermissionMatrix,
  type ToolAmount,
  type ToolDisplay,
  type ToolRecipient,
  type ToolSpec,
  type Verb,
} from "@countersign/core";
import { z } from "zod";
// v0.14 W4-C
import type { WriteAttemptServices } from "./attempts";
import type { BrowserServices } from "./browser/services";
import type { CredentialsAccessor } from "./credentials-accessor";
import type { Logger } from "./logger";
import type { MessagingServices } from "./messaging/services";
import type { TokenRefresher } from "./oauth/tokens";
import { manifestDefaultProblems } from "./permissions";
import type { EmailServices } from "./resend/index";
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
  /** Contacts and consent for email sends (resend/index.ts). */
  email?: EmailServices;
  /** The catalogue, a browser, codes and documents, for browser logins (browser/services.ts). */
  browser?: BrowserServices;
  /** The client's stored documents, for tools that send one to the tool (QBO attachments). */
  documents?: DocumentServices;
  // v0.12 W1-F
  /** What sync already stored for this connection (QBO: duplicate bills, receivable ids). */
  records?: SyncedRecordServices;
  // v0.14 W4-C
  /** Writes the provider takes no idempotency key for (Slack): attempts, refusals, results. */
  attempts?: WriteAttemptServices;
}

// v0.12 W1-F: synced records, read for the call's one client and connection (apps/api/src/qbo).
export interface SyncedRecordServices {
  /**
   * Synced bills (not deleted) from the vendor with this id in the tool whose document number
   * normalizes to the same letters and digits: their transaction ids and ids in the tool.
   */
  syncedBills(q: {
    vendorExternalId: string;
    docNumber: string;
  }): Promise<{ transactionId: string; externalId: string }[]>;
  /** Receivable ids by the invoice's id in the tool, for those synced (others are left out). */
  receivableIds(externalIds: string[]): Promise<Record<string, string>>;
}

/** A stored document's bytes, read for one client (the call's). */
export interface StoredFile {
  id: string;
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
  sha256: string;
}

export interface DocumentServices {
  /** The document with this id in the call's client, or null (unknown, or another client's). */
  read(documentId: string): Promise<StoredFile | null>;
  // P-3: attachments both ways (docs/plan.md §1.65)
  /** The document's record without its bytes (for approval cards), or null as `read`. */
  describe?(documentId: string): Promise<DocumentFacts | null>;
  /**
   * A link to the document's bytes that works for five minutes, for a provider that fetches the
   * file itself (Twilio's MediaUrl, Meta's media link); null as `read`.
   */
  signedUrl?(documentId: string): Promise<string | null>;
}

/** A stored document's record, without its bytes. */
export interface DocumentFacts {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
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
  // v0.14 W4-D
  /**
   * The before state the approver saw when the change was proposed (`external_action.before`),
   * when there was a proposal. A tool may refuse a write whose record changed since (Sheets).
   */
  proposedBefore?: unknown;
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
  /** The record type it reads (ToolSpec `entity`, v0.12). */
  entity?: string;
  /** v0.12 W2-A: the input field that names its record type (ToolSpec `entityInput`). */
  entityInput?: { field: string; values: Record<string, string> };
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
      ...(def.entity === undefined ? {} : { entity: def.entity }),
      ...(def.entityInput === undefined ? {} : { entityInput: def.entityInput }),
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
  /** How the change reads on its approval card (ToolSpec `display`). */
  display?: ToolDisplay;
  // v0.12 W1-G: the input field naming the person a send messages (ToolSpec `recipient`).
  recipient?: ToolRecipient;
  /** The record type it touches (ToolSpec `entity`, v0.12). */
  entity?: string;
  /** v0.12 W2-A: the input field that names its record type (ToolSpec `entityInput`). */
  entityInput?: { field: string; values: Record<string, string> };
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
      ...(def.display === undefined ? {} : { display: def.display }),
      ...(def.recipient === undefined ? {} : { recipient: def.recipient }),
      ...(def.entity === undefined ? {} : { entity: def.entity }),
      ...(def.entityInput === undefined ? {} : { entityInput: def.entityInput }),
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
  /**
   * v0.12 bankfeed: the connection being signed in again, when it still holds credentials (a
   * hosted link flow's reconnect keeps the same grant: Plaid Link's update mode). Absent otherwise.
   */
  existing?: ConnectionContext;
  // v0.14 W4-A
  /**
   * Whether this account (a grant's `externalAccountId`) is connected for this connector by another
   * client. A connector whose account must belong to one client only (a WhatsApp number: inbound
   * messages are routed by it) asks before it changes anything at the provider.
   */
  accountTaken?(externalAccountId: string): Promise<boolean>;
}

// v0.12 bankfeed (docs/plan.md §1.52): a provider whose sign-in is its own hosted widget opened in
// the page (Plaid Link), not a redirect. The platform signs a state as for OAuth; the connector
// makes a short-lived token the portal opens the widget with; the widget's result comes back
// through the same callback route (`handleCallback`) with that state.
export interface LinkRequest {
  tenantId: string;
  userId: string;
  /** Where an OAuth bank sends the person back to (the portal's callback page). */
  redirectUri: string;
  /** Where the provider posts this client's notifications. */
  webhookUrl: string;
  /** The reader's language (a portal locale); the widget may support fewer. */
  language?: string;
  /** The connection being reconnected, when it still holds credentials (update mode). */
  reconnect?: ConnectionContext;
}

export interface LinkStart {
  /** v0.14 W4-A: `meta` is Meta's Embedded Signup (WhatsApp), opened with Meta's JS SDK. */
  provider: "plaid" | "meta";
  /**
   * Plaid: short-lived and single-use; it opens the widget, and reads nothing by itself. Meta:
   * the Embedded Signup configuration's id (public; the signed state goes with it).
   */
  token: string;
  expiresAt: string | null;
  // v0.14 W4-A: Meta's public values for its SDK.
  /** Meta: the app's id. */
  appId?: string;
  /** Meta: the Graph API version the SDK is set to. */
  graphVersion?: string;
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
  /** v0.12 bankfeed: a hosted link widget in place of `authorize`'s redirect (Plaid Link). */
  beginLink?(req: LinkRequest): Promise<LinkStart>;
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
  /**
   * Which binding a tool call uses, from its input (docs/plan.md §1.26 "Binding browser sites"):
   * agents' bindings are keyed by connector id, and a connector whose connections are told apart
   * by something in the input (a browser site: `browser:<site slug>`) names the key here. Absent:
   * the connector id. The key must be the connector id or start with `<connector id>:`; null (or a
   * key that doesn't) refuses the call like an unbound connector.
   */
  bindingKey?(input: unknown): string | null;
  // v0.14 W4-A
  /**
   * For a tool id several connectors supply (a shared namespace: `message.get` from Twilio and
   * Meta), whether this connector's handler is for this input (Meta's `message.get` takes only a
   * `wamid.`). Absent: every input. Used only to choose among connectors an agent is bound to.
   */
  handlesInput?(toolId: string, input: unknown): boolean;
  /**
   * Where the connection's synced records (raw_record) name an id an approval card shows, for ids
   * the change's before state leaves unnamed (a line's account or item). `list` is the tool
   * display's names list ("accounts", "items"). Each lookup is a synced record type, a shape a
   * record naming the id contains (jsonb `@>`), and how to read the name from that record. Absent
   * or empty: the card has no name for the id.
   */
  syncedNames?(list: string, id: string): readonly SyncedNameLookup[];
}

/** One place a synced record may name an id (see `Connector.syncedNames`). */
export interface SyncedNameLookup {
  entityType: string;
  contains: JsonObject;
  name(payload: unknown): string | null;
}

/**
 * The binding key a call to `connector` uses with this input: its `bindingKey` hook's answer, kept
 * within the connector's own keys, or the connector id. Null refuses the call.
 */
export function bindingKeyFor(connector: Connector, input: unknown): string | null {
  const id = connector.manifest.id;
  if (!connector.bindingKey) return id;
  let key: string | null;
  try {
    key = connector.bindingKey(input);
  } catch {
    return null;
  }
  // A connector never reaches another connector's binding through its hook.
  if (key === null || (key !== id && !key.startsWith(`${id}:`))) return null;
  return key;
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
    credentialFields,
    permissionEntities,
    testOnly,
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
    ...(credentialFields === undefined ? {} : { credentialFields }),
    // v0.12 W2-A
    ...(permissionEntities === undefined ? {} : { permissionEntities }),
    ...(testOnly === undefined ? {} : { testOnly }),
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
  // v0.12 bankfeed: a hosted link widget (beginLink) starts a sign-in in place of a redirect.
  if (auth === "oauth2" && (!(hooks.authorize || hooks.beginLink) || !hooks.handleCallback)) {
    problems.push("oauth2 connectors need authorize and handleCallback (or beginLink for a link)");
  }
  problems.push(...manifestDefaultProblems({ defaultPermissions }));
  if (problems.length > 0 || !parsed.success) throw new ConnectorDefinitionError(id, problems);
  return { ...hooks, manifest: parsed.data, tools: handlers };
}
