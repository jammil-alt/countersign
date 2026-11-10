// Skill model (2026-11-10): "AI: typed data in (text, documents too)". An AI (task) skill's input
// field marked `x-document` names one of the client's documents; the runtime attaches its file to
// the model call (a PDF as a `document` block, an image as an `image` block) beside the input JSON.
// The file is data, never instructions (invariant 9); only the client's own documents are read
// (the documents port is scoped to the run's client, invariant 1).

import type { JsonSchema, SkillDefinition } from "@countersign/core";
import { base64, documentBlock } from "@countersign/documents";
import { DOCUMENT_INPUT_KEYWORD } from "../tools/docs-split";
import type { DocumentsPort } from "../tools/types";

export type AttachedBlock = ReturnType<typeof documentBlock>;

// DECISION: a document reaches an AI skill through its input: a top-level field marked
// `x-document: true` in the input schema (a JSON Schema extension keyword, so no stored skill
// changes and the field stays a plain id for typing); only task skills attach.
/** The top-level input fields an AI skill marks as documents (`x-document: true`). */
export function documentInputFields(def: Pick<SkillDefinition, "input">): string[] {
  const props = (def.input as JsonSchema & { properties?: Record<string, unknown> }).properties;
  if (!props || typeof props !== "object") return [];
  return Object.entries(props)
    .filter(([, s]) => (s as Record<string, unknown> | null)?.[DOCUMENT_INPUT_KEYWORD] === true)
    .map(([k]) => k);
}

/**
 * The blocks to attach for a task skill's input, in field order; none when the skill marks no
 * document field. A field left empty attaches nothing; a document that can't be read fails.
 */
export async function documentAttachments(
  documents: DocumentsPort | undefined,
  tenantId: string,
  def: Pick<SkillDefinition, "input" | "mode">,
  input: unknown,
): Promise<{ ok: true; blocks: AttachedBlock[] } | { ok: false; error: string }> {
  if (def.mode !== "task") return { ok: true, blocks: [] };
  const fields = documentInputFields(def);
  if (fields.length === 0) return { ok: true, blocks: [] };
  if (!documents?.file) {
    return { ok: false, error: "reading a document is not available here" };
  }
  const values = (input ?? {}) as Record<string, unknown>;
  const blocks: AttachedBlock[] = [];
  for (const field of fields) {
    const id = values[field];
    if (id === undefined || id === null || id === "") continue;
    if (typeof id !== "string") return { ok: false, error: `${field} is a document id` };
    try {
      const file = await documents.file(tenantId, id);
      blocks.push(documentBlock(file.mimeType, base64(file.bytes)));
    } catch (error) {
      return {
        ok: false,
        error: `couldn't read document ${id}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return { ok: true, blocks };
}
