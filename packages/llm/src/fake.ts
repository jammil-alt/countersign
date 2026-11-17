// A scripted model for tests: answers each call with the next scripted response, and keeps every
// request it was sent so a test can assert on prompts and tools.

import { AnthropicError } from "./anthropic";
import type * as Anthropic from "./messages";
import type { LlmMessage, LlmRequest, LlmTransport } from "./transport";

export interface FakeUsage {
  readonly input?: number;
  readonly output?: number;
  readonly cacheWrite?: number;
  readonly cacheRead?: number;
}

export type FakeTurn =
  | { readonly text: string; readonly usage?: FakeUsage }
  | {
      readonly toolUse: { readonly name: string; readonly input: unknown };
      readonly text?: string;
      readonly usage?: FakeUsage;
      /** The answer ran out of `max_tokens` during the call: its input is incomplete. */
      readonly cutOff?: true;
    }
  | { readonly refusal: true; readonly usage?: FakeUsage }
  | { readonly error: Error }
  | { readonly message: LlmMessage }
  | ((request: LlmRequest) => FakeTurn);

export class FakeModelExhaustedError extends Error {
  override name = "FakeModelExhaustedError";
}

let counter = 0;

export function fakeMessage(
  model: string,
  content: Anthropic.ContentBlock[],
  stopReason: Anthropic.StopReason,
  usage: FakeUsage = {},
): LlmMessage {
  counter += 1;
  return {
    id: `msg_fake_${counter}`,
    type: "message",
    role: "assistant",
    model,
    content,
    container: null,
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: usage.input ?? 100,
      output_tokens: usage.output ?? 20,
      cache_creation_input_tokens: usage.cacheWrite ?? 0,
      cache_read_input_tokens: usage.cacheRead ?? 0,
      cache_creation: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: "standard",
    },
  } as LlmMessage;
}

const textBlock = (text: string): Anthropic.TextBlock => ({ type: "text", text, citations: null });

function toMessage(turn: Exclude<FakeTurn, (r: LlmRequest) => FakeTurn>, model: string) {
  if ("error" in turn) throw turn.error;
  if ("message" in turn) return turn.message;
  if ("refusal" in turn) return fakeMessage(model, [], "refusal", turn.usage);
  if ("toolUse" in turn) {
    counter += 1;
    const block = {
      type: "tool_use",
      id: `toolu_fake_${counter}`,
      name: turn.toolUse.name,
      input: turn.toolUse.input,
      caller: { type: "direct" },
    } as Anthropic.ToolUseBlock;
    const content = turn.text ? [textBlock(turn.text), block] : [block];
    return fakeMessage(model, content, turn.cutOff ? "max_tokens" : "tool_use", turn.usage);
  }
  return fakeMessage(model, [textBlock(turn.text)], "end_turn", turn.usage);
}

/**
 * Models that always think, and so refuse a forced tool choice (`{type: "tool"}` or
 * `{type: "any"}`) with a 400, as the API does (see callTool's DECISION in ./client.ts).
 */
const REFUSES_FORCED_TOOL_CHOICE = /^claude-(sonnet|opus)-5-5(?!\d)/;

/** The 400 the API answers a forced tool choice with on a model that always thinks. */
export function forcedToolChoiceError(model: string): AnthropicError | null {
  if (!REFUSES_FORCED_TOOL_CHOICE.test(model)) return null;
  const body = {
    type: "error",
    error: {
      type: "invalid_request_error",
      message: `tool_choice that forces tool use is not supported by ${model}: use tool_choice auto`,
    },
  };
  return new AnthropicError(`400 ${JSON.stringify(body)}`, 400, body, null);
}

export class FakeModel implements LlmTransport {
  readonly requests: LlmRequest[] = [];
  readonly #script: FakeTurn[];

  constructor(script: readonly FakeTurn[] = []) {
    this.#script = [...script];
  }

  /** Queue more turns. */
  push(...turns: FakeTurn[]): this {
    this.#script.push(...turns);
    return this;
  }

  get remaining(): number {
    return this.#script.length;
  }

  async create(request: LlmRequest): Promise<LlmMessage> {
    this.requests.push(structuredClone(request));
    // Strict as the API: a forced tool choice on a model that refuses it fails before any answer,
    // so the scripted turn is not used.
    const choice = request.tool_choice?.type;
    if (choice === "tool" || choice === "any") {
      const refused = forcedToolChoiceError(request.model);
      if (refused) throw refused;
    }
    let turn = this.#script.shift();
    if (turn === undefined) {
      throw new FakeModelExhaustedError(
        `FakeModel has no scripted response for call ${this.requests.length}`,
      );
    }
    while (typeof turn === "function") turn = turn(request);
    return toMessage(turn, request.model);
  }
}
