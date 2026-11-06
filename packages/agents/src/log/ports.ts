// The runtime's ports over the database, for apps/api and the workflow executor to pass in.

import type { Db } from "@countersign/db";
import { dbRuntimeStore } from "../registry/runtime-store";
import type { ReleasePort, RuntimePorts } from "../runtime/ports";
// v0.12 W2-D
import { type AccountViews, dbAccountPort } from "./account-port";
import { dbCarriedActions } from "./carried-actions";
import { dbConnectionAttention } from "./connection-attention";
import { dbDirectoryPort } from "./directory-port";
import { type DbDocumentsOptions, dbDocumentsPort } from "./documents-port";
import { dbExternalActions, type Emit } from "./external-actions";
import { dbFindingsPort } from "./findings-port";
import { dbHealthPort } from "./health-port";
// v0.12 W2-E
import { dbInboundPort } from "./inbound-port";
import { dbKnowledgePort } from "./knowledge-port";
import type { ModelCallPort } from "./model-calls";
import { dbPlatformStore } from "./platform-store";
import { dbRunLog } from "./run-log";
import { dbThreadsPort } from "./threads-port";

export interface DbPortsOptions {
  /**
   * Emits events in the change's own transaction (packages/senses): `external_action.done` /
   * `.failed`, `connection.needs_attention`, `health.checked`.
   */
  emit?: Emit;
  /** The documents capability for `docs.*` tools (object storage, the model transport, a signer). */
  documents?: DbDocumentsOptions;
  /** Human release, from apps/api (it sends codes); absent: connections that need one refuse. */
  release?: ReleasePort;
  /** A connector id's display name, for the health tools (apps/api passes the registry's). */
  connectorName?: (connectorId: string) => string;
  // v0.12 W1-E
  /** Model calls' rows and bodies (apps/api passes its writer with the R2 bucket); absent: none. */
  modelCalls?: ModelCallPort;
  // v0.12 W2-D
  /** The portal's views and writes for Sloan's `account.*` (apps/api passes them); absent: they fail. */
  account?: AccountViews;
}

export function createDbPorts(db: Db, options: DbPortsOptions = {}): RuntimePorts {
  const emit = options.emit ? { emit: options.emit } : {};
  return {
    store: dbRuntimeStore(db),
    log: dbRunLog(db),
    actions: dbExternalActions(db, emit),
    platform: dbPlatformStore(db),
    knowledge: dbKnowledgePort(db),
    directory: dbDirectoryPort(db),
    health: dbHealthPort(db, options.connectorName ? { connectorName: options.connectorName } : {}),
    findings: dbFindingsPort(db, emit),
    attention: dbConnectionAttention(db, emit),
    // v0.12 W1-C
    threads: dbThreadsPort(db, emit),
    // v0.12 W2-E
    inbound: dbInboundPort(db),
    ...(options.documents ? { documents: dbDocumentsPort(db, options.documents) } : {}),
    ...(options.release ? { release: options.release } : {}),
    // v0.12 W1-E: a retry's carried approvals; model calls when apps/api keeps them.
    carried: dbCarriedActions(db),
    ...(options.modelCalls ? { modelCalls: options.modelCalls } : {}),
    // v0.12 W2-D: Sloan's account, as the portal shows it.
    ...(options.account ? { account: dbAccountPort(db, options.account) } : {}),
  };
}
