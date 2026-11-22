// Round 4 D (docs/plan.md §1.211; ARCHITECTURE §10.18): the verifier's sources, read from the
// rows the run already left: its trigger, its earlier steps' outputs, what it read (`run_subject`)
// and each document's latest reading (`doc_extraction`). One short transaction scoped to the run's
// own client (invariant 1); nothing from another run, agent or client.

import {
  type Db,
  docExtraction,
  document,
  run,
  runSubject,
  stepRun,
  withTenant,
} from "@countersign/db";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import type { VerifyPort, VerifySources } from "../runtime/ports";

/** How many earlier steps and subjects the verifier is shown at most. */
const STEPS_MAX = 30;
const SUBJECTS_MAX = 30;
const DOCUMENTS_MAX = 5;

export function dbVerifyPort(db: Db): VerifyPort {
  return {
    sources(tenantId, input): Promise<VerifySources> {
      return withTenant(db, tenantId, async (tx) => {
        const [r] = await tx
          .select({ trigger: run.trigger })
          .from(run)
          .where(and(eq(run.id, input.runId), eq(run.tenantId, tenantId)));
        const steps = await tx
          .select({ nodeId: stepRun.nodeId, output: stepRun.output })
          .from(stepRun)
          .where(
            and(
              eq(stepRun.tenantId, tenantId),
              eq(stepRun.runId, input.runId),
              ne(stepRun.id, input.stepRunId),
              eq(stepRun.status, "succeeded"),
            ),
          )
          .orderBy(asc(stepRun.startedAt), asc(stepRun.id))
          .limit(STEPS_MAX);
        const subjects = await tx
          .select({
            id: runSubject.id,
            kind: runSubject.kind,
            label: runSubject.label,
            number: runSubject.number,
            amount: runSubject.amount,
            currency: runSubject.currency,
            recordId: runSubject.recordId,
          })
          .from(runSubject)
          .where(
            and(
              eq(runSubject.tenantId, tenantId),
              eq(runSubject.runId, input.runId),
              eq(runSubject.role, "read"),
            ),
          )
          .orderBy(asc(runSubject.createdAt))
          .limit(SUBJECTS_MAX);
        const documentIds = [
          ...new Set(
            subjects
              .filter((s) => s.kind === "document" && s.recordId !== null)
              .map((s) => s.recordId as string),
          ),
        ].slice(0, DOCUMENTS_MAX);
        const documents: VerifySources["documents"] = [];
        if (documentIds.length > 0) {
          const docs = await tx
            .select({ id: document.id, filename: document.filename })
            .from(document)
            .where(and(eq(document.tenantId, tenantId), inArray(document.id, documentIds)));
          for (const d of docs) {
            const [reading] = await tx
              .select({
                header: docExtraction.header,
                currency: docExtraction.currency,
                subtotal: docExtraction.subtotal,
                tax: docExtraction.tax,
                total: docExtraction.total,
                id: docExtraction.id,
              })
              .from(docExtraction)
              .where(and(eq(docExtraction.tenantId, tenantId), eq(docExtraction.documentId, d.id)))
              .orderBy(desc(docExtraction.createdAt))
              .limit(1);
            documents.push({ documentId: d.id, filename: d.filename, reading: reading ?? null });
          }
        }
        return {
          trigger: r?.trigger ?? null,
          steps: steps.map((s) => ({ nodeId: s.nodeId, output: s.output })),
          subjects,
          documents,
        };
      });
    },
  };
}
