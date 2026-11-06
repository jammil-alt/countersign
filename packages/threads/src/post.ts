// A person's message (docs/plan.md §1.38 "Posting", "Commands"): plain text, or `/word …` parsed
// into a command message that names an agent (or, for an operator on an agent's thread, a skill).
// An unknown command is kept as the person's text with a system answer after it, and starts
// nothing. The caller has checked who may post here and that the sources are this client's.

import { type Locale, type MessageAudience, parseCommand, THREAD_WORDS } from "@countersign/core";
import type { Tx } from "@countersign/db";
import { resolveCommand } from "./commands";
import { type EmitPosted, type MessageRow, postMessage, type ThreadRow } from "./store";

export interface PersonPostInput {
  tenantId: string;
  thread: Pick<ThreadRow, "id" | "tenantId" | "subjectType" | "subjectId">;
  userId: string;
  /** An operator of the client (back office), not a client member. */
  operator: boolean;
  text: string;
  sources: readonly string[];
  audience: MessageAudience;
  /** The client's language, for the system's answer. */
  locale: Locale;
}

/** Posts the message (and a system answer to an unknown command); returns them in order. */
export async function postAsPerson(
  tx: Tx,
  input: PersonPostInput,
  emitPosted?: EmitPosted,
): Promise<MessageRow[]> {
  const base = {
    tenantId: input.tenantId,
    thread: input.thread,
    senderType: "user" as const,
    senderId: input.userId,
    sources: input.sources,
    audience: input.audience,
  };
  const parsed = parseCommand(input.text);
  if (!parsed) {
    return [
      await postMessage(tx, { ...base, kind: "text", body: { text: input.text } }, emitPosted),
    ];
  }
  const target = await resolveCommand(tx, {
    tenantId: input.tenantId,
    thread: input.thread,
    parsed,
    operator: input.operator,
  });
  if (target.kind !== "unknown") {
    const posted = await postMessage(
      tx,
      {
        ...base,
        kind: "command",
        command: target.command,
        body: { text: input.text, args: parsed.args },
      },
      emitPosted,
    );
    return [posted];
  }
  const posted = await postMessage(
    tx,
    { ...base, kind: "text", body: { text: input.text } },
    emitPosted,
  );
  const answer = await postMessage(
    tx,
    {
      tenantId: input.tenantId,
      thread: input.thread,
      senderType: "system",
      senderId: null,
      kind: "text",
      body: { text: THREAD_WORDS[input.locale].unknownCommand(target.name) },
      sources: [],
      audience: input.audience,
    },
    emitPosted,
  );
  return [posted, answer];
}
