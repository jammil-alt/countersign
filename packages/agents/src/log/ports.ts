// The runtime's ports over the database, for apps/api and the workflow executor to pass in.

import type { Db } from "@countersign/db";
import { dbRuntimeStore } from "../registry/runtime-store";
import type { RuntimePorts } from "../runtime/ports";
import { dbExternalActions, type Emit } from "./external-actions";
import { dbPlatformStore } from "./platform-store";
import { dbRunLog } from "./run-log";

export interface DbPortsOptions {
  /** Emits `external_action.done` / `.failed` in the action's transaction (packages/senses). */
  emit?: Emit;
}

export function createDbPorts(db: Db, options: DbPortsOptions = {}): RuntimePorts {
  return {
    store: dbRuntimeStore(db),
    log: dbRunLog(db),
    actions: dbExternalActions(db, options.emit ? { emit: options.emit } : {}),
    platform: dbPlatformStore(db),
  };
}
