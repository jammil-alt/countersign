// HIPAA mode on the back office's MCP connector (docs/plan.md §1.190, docs/hipaa-plan.md T1).
// What an operator's tools return is read by their Claude, so a client's data reaches Anthropic
// through claude.ai (`MCP_CONNECTOR_FEATURE`, processor `claude_ai`). Held as Reggie and the
// questions across clients are (§1.143): a call that names one client is held to that client; any
// other call may return any client served, so it is held to all of them. Only the lists of
// clients (whoami, clients_list) leave a held client out instead of refusing, so the operator can
// still find the clients they may ask about.

import {
  ComplianceRefusal,
  MCP_CONNECTOR_FEATURE,
  PROCESSOR_NAMES,
  parseCoveredProcessors,
  processingRefusal,
} from "@countersign/core";
import type { Db } from "@countersign/db";
import { profileReader, refusingClients } from "../compliance/policy";

const [PROCESSOR] = MCP_CONNECTOR_FEATURE.processors as readonly ["claude_ai"];

/**
 * Of the clients an operator serves, those in HIPAA mode without `claude_ai` covered: their data
 * may not go out through the connector. One query for all of them; none when it is covered.
 */
export async function heldFromConnector(
  db: Db,
  baaProcessors: string | null | undefined,
  served: readonly string[],
): Promise<Set<string>> {
  const covered = parseCoveredProcessors(baaProcessors);
  if (served.length === 0 || covered.has(PROCESSOR)) return new Set();
  return refusingClients([...new Set(served)], profileReader(db), covered, PROCESSOR);
}

/**
 * Throws a `ComplianceRefusal` (answered as `hipaa`, 409) before a tool runs when what it may
 * return carries a held client's data.
 */
// DECISION: matching §1.143 exactly. A call with `client` is held to that client alone (each tool
// that takes one returns only that client's). A call without one, including a read by id (a run,
// a feedback item, a Dev queue request) whose client is known only once read, is refused while any
// client served is held, as Reggie is: nothing is read first to decide.
export function refuseHeld(
  held: ReadonlySet<string>,
  call: { tool: string; client: string | null; leavesOut: boolean },
): void {
  if (held.size === 0) return;
  const what = `${call.tool} through Claude`;
  if (call.client) {
    if (!held.has(call.client)) return;
    const refusal = processingRefusal(
      { hipaa: true },
      new Set(),
      MCP_CONNECTOR_FEATURE.processors,
      what,
    );
    throw new ComplianceRefusal(refusal ?? what);
  }
  if (call.leavesOut) return;
  const n = held.size;
  throw new ComplianceRefusal(
    `${what} may return any client you serve and sends data to ${PROCESSOR_NAMES[PROCESSOR]}, which has no signed BAA; ${n === 1 ? "1 client you serve is" : `${n} clients you serve are`} in HIPAA mode. Name another client with \`client\`, or use the back office.`,
  );
}
