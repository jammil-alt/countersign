// P-7: `comms.translate` over the database (docs/plan.md §1.69): the original is read in the run's
// client only (another client's id is not found, invariant 1), the client's settings decide the
// model and the daily limit, and the translation is stored beside the original with the agent's
// version, run and step.

import { type Db, withTenant } from "@countersign/db";
import type { LlmTransport } from "@countersign/llm";
import type { TranslationPort } from "../tools/translate";
import { clientTranslation, originalText, translateAndStore } from "./translations";

export interface TranslationPortOptions {
  /** The run's model transport (already held to the client's HIPAA mode by apps/api). */
  transport: LlmTransport;
  now?: () => Date;
}

export function dbTranslationPort(db: Db, options: TranslationPortOptions): TranslationPort {
  return {
    async translate(tenantId, input) {
      const read = await withTenant(db, tenantId, async (tx) => ({
        client: await clientTranslation(tx, tenantId),
        original: await originalText(tx, tenantId, input.sourceId, input.field),
      }));
      if (!read.original) {
        throw new Error(`no message ${input.sourceId} with text at ${input.field} for this client`);
      }
      const to = input.to ?? read.client.settings.working ?? read.client.language ?? "en";
      const row = await translateAndStore(db, options.transport, {
        tenantId,
        source: read.original.source,
        field: input.field,
        direction: "in",
        text: read.original.text,
        to,
        settings: read.client.settings,
        agent: input.agent,
        onCall: input.onCall,
        now: options.now?.(),
      });
      return {
        status: row.status,
        reason: row.reason ?? null,
        sourceId: input.sourceId,
        field: input.field,
        from: row.sourceLanguage,
        to,
        text: row.text ?? null,
        truncated: row.truncated,
        translationId: row.id,
        sources: [input.sourceId, row.id],
      };
    },
  };
}
