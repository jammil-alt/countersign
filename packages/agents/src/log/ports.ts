// The runtime's ports over the database, for apps/api and the workflow executor to pass in.

import type { Db } from "@countersign/db";
import { dbRuntimeStore } from "../registry/runtime-store";
import type { ReleasePort, RuntimePorts } from "../runtime/ports";
import { type DbDocumentsOptions, dbDocumentsPort } from "./documents-port";
import { dbExternalActions, type Emit } from "./external-actions";
import { dbKnowledgePort } from "./knowledge-port";
import { dbPlatformStore } from "./platform-store";
import { dbRunLog } from "./run-log";

export interface DbPortsOptions {
  /** Emits `external_action.done` / `.failed` in the action's transaction (packages/senses). */
  emit?: Emit;
  /** The documents capability for `docs.*` tools (object storage, the model transport, a signer). */
  documents?: DbDocumentsOptions;
  /** Human release, from apps/api (it sends codes); absent: connections that need one refuse. */
  release?: ReleasePort;
}

export function createDbPorts(db: Db, options: DbPortsOptions = {}): RuntimePorts {
  return {
    store: dbRuntimeStore(db),
    log: dbRunLog(db),
    actions: dbExternalActions(db, options.emit ? { emit: options.emit } : {}),
    platform: dbPlatformStore(db),
    knowledge: dbKnowledgePort(db),
    ...(options.documents ? { documents: dbDocumentsPort(db, options.documents) } : {}),
    ...(options.release ? { release: options.release } : {}),
  };
}
