// The model client the platform calls: one request in, one message out, with usage and cost
// worked out at call time and handed to `onCall` (successes and failures alike) so the caller can
// write it on the step run (ARCHITECTURE §13).

import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { DEFAULT_MODEL, type ModelId } from "./models";
import { costOf, type ModelPrice, PRICES } from "./pricing";
import type { LlmMessage, LlmRequest, LlmTransport } from "./transport";
import { type LlmUsage, usageOf, ZERO_USAGE } from "./usage";

export interface LlmCallRecord {
  readonly model: ModelId;
  readonly ok: boolean;
  readonly usage: LlmUsage;
  /** USD, 6 places; null when the model has no price or the call failed before an answer. */
  readonly costUsd: string | null;
  readonly durationMs: number;
  readonly stopReason: string | null;
  readonly error?: string;
  /** Free-form label from the caller (skill id, step id, …) carried through to `onCall`. */
  readonly label?: string;
}

export interface LlmCallResult {
  readonly message: LlmMessage;
  readonly record: LlmCallRecord;
}

export interface LlmClientOptions {
  readonly transport: LlmTransport;
  readonly defaultModel?: ModelId;
  readonly defaultMaxTokens?: number;
  readonly prices?: Readonly<Record<ModelId, ModelPrice>>;
  readonly onCall?: (record: LlmCallRecord) => void | Promise<void>;
  /** Monotonic-ish milliseconds, for durations. Tests pass a fixed clock. */
  readonly clock?: () => number;
}

export type MessageInput = Omit<LlmRequest, "model" | "max_tokens"> & {
  readonly model?: ModelId;
  readonly max_tokens?: number;
};

export interface CallToolInput<T> {
  readonly model?: ModelId;
  readonly system?: string | Anthropic.TextBlockParam[];
  readonly messages: Anthropic.MessageParam[];
  readonly tool: {
    readonly name: string;
    readonly description: string;
    readonly schema: z.ZodType<T>;
    /** Ask the API to keep arguments schema-valid. Only for schemas strict mode accepts. */
    readonly strict?: boolean;
  };
  readonly maxTokens?: number;
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max";
  readonly label?: string;
  readonly signal?: AbortSignal;
}

export interface CallToolResult<T> extends LlmCallResult {
  readonly value: T;
}

export type LlmToolErrorCode = "no_tool_call" | "invalid_input" | "refusal" | "max_tokens";

/** The model's answer could not be used: no call to the tool, input that fails the schema, etc. */
export class LlmToolError extends Error {
  override name = "LlmToolError";
  readonly code: LlmToolErrorCode;
  readonly toolName: string;
  /** The tool input the model sent, when it sent one. */
  readonly input: unknown;
  readonly issues: readonly z.core.$ZodIssue[];
  readonly result: LlmCallResult;
  constructor(
    code: LlmToolErrorCode,
    message: string,
    details: {
      toolName: string;
      result: LlmCallResult;
      input?: unknown;
      issues?: readonly z.core.$ZodIssue[];
    },
  ) {
    super(message);
    this.code = code;
    this.toolName = details.toolName;
    this.input = details.input;
    this.issues = details.issues ?? [];
    this.result = details.result;
  }
}

export interface LlmClient {
  message(
    input: MessageInput,
    options?: { label?: string; signal?: AbortSignal },
  ): Promise<LlmCallResult>;
  callTool<T>(input: CallToolInput<T>): Promise<CallToolResult<T>>;
}

/** The JSON Schema the API sees for a Zod schema: its input form, without `$schema`. */
export function toolInputSchema(schema: z.ZodType): Anthropic.Tool.InputSchema {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  if (json.type !== "object") {
    throw new Error("a tool's input schema must be an object schema");
  }
  return json as Anthropic.Tool.InputSchema;
}

export function createLlmClient(options: LlmClientOptions): LlmClient {
  const { transport } = options;
  const prices = options.prices ?? PRICES;
  const clock = options.clock ?? (() => Date.now());
  const defaultModel = options.defaultModel ?? DEFAULT_MODEL;
  const defaultMaxTokens = options.defaultMaxTokens ?? 16_000;

  async function report(record: LlmCallRecord) {
    await options.onCall?.(record);
  }

  async function message(
    input: MessageInput,
    opts: { label?: string; signal?: AbortSignal } = {},
  ): Promise<LlmCallResult> {
    const request = {
      ...input,
      model: input.model ?? defaultModel,
      max_tokens: input.max_tokens ?? defaultMaxTokens,
    } as LlmRequest;
    const started = clock();
    const label = opts.label === undefined ? {} : { label: opts.label };
    let response: LlmMessage;
    try {
      response = await transport.create(request, opts.signal ? { signal: opts.signal } : {});
    } catch (error) {
      await report({
        model: request.model,
        ok: false,
        usage: ZERO_USAGE,
        costUsd: null,
        durationMs: clock() - started,
        stopReason: null,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        ...label,
      });
      throw error;
    }
    const usage = usageOf(response);
    const record: LlmCallRecord = {
      // Priced by the model that answered, which is what was billed.
      model: response.model || request.model,
      ok: response.stop_reason !== "refusal",
      usage,
      costUsd: costOf(response.model || request.model, usage, prices),
      durationMs: clock() - started,
      stopReason: response.stop_reason,
      ...label,
    };
    await report(record);
    return { message: response, record };
  }

  async function callTool<T>(input: CallToolInput<T>): Promise<CallToolResult<T>> {
    const { tool } = input;
    // DECISION: no forced tool_choice. `{type: "tool"}` and `{type: "any"}` are rejected (400) by
    // claude-sonnet-5-5 and claude-opus-5-5, our defaults, so every model gets `auto` with
    // parallel calls off and an instruction naming the tool; the answer is validated with Zod
    // either way, and a missing call is an error, not a retry.
    const instruction: Anthropic.TextBlockParam = {
      type: "text",
      text: `Give your answer by calling the \`${tool.name}\` tool exactly once.`,
    };
    const system =
      input.system === undefined
        ? [instruction]
        : typeof input.system === "string"
          ? [{ type: "text" as const, text: input.system }, instruction]
          : [...input.system, instruction];
    const result = await message(
      {
        ...(input.model ? { model: input.model } : {}),
        max_tokens: input.maxTokens ?? defaultMaxTokens,
        system,
        messages: input.messages,
        tools: [
          {
            name: tool.name,
            description: tool.description,
            input_schema: toolInputSchema(tool.schema),
            ...(tool.strict ? { strict: true } : {}),
          },
        ],
        tool_choice: { type: "auto", disable_parallel_tool_use: true },
        ...(input.effort ? { output_config: { effort: input.effort } } : {}),
      },
      {
        ...(input.label === undefined ? {} : { label: input.label }),
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
    const { message: response } = result;
    if (response.stop_reason === "refusal") {
      throw new LlmToolError("refusal", `the model declined to call ${tool.name}`, {
        toolName: tool.name,
        result,
      });
    }
    const call = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === tool.name,
    );
    if (!call) {
      const code = response.stop_reason === "max_tokens" ? "max_tokens" : "no_tool_call";
      throw new LlmToolError(
        code,
        code === "max_tokens"
          ? `the answer was cut off at max_tokens before calling ${tool.name}`
          : `the model answered without calling ${tool.name}`,
        { toolName: tool.name, result },
      );
    }
    const parsed = tool.schema.safeParse(call.input);
    if (!parsed.success) {
      throw new LlmToolError(
        "invalid_input",
        `${tool.name} input failed validation: ${z.prettifyError(parsed.error)}`,
        { toolName: tool.name, result, input: call.input, issues: parsed.error.issues },
      );
    }
    return { ...result, value: parsed.data };
  }

  return { message, callTool };
}
