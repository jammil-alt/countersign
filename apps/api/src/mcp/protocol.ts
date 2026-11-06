// The Model Context Protocol over Streamable HTTP, server side, as small as the back office needs
// (docs/plan.md §1.34): JSON-RPC 2.0 requests in a POST, one JSON answer each; no SSE stream, no
// sessions, no batches. Generic over its tools, so a client-facing server can reuse it with its
// own tools and context; authentication happens before this (./routes.ts).
//
// Spec followed: MCP 2025-11-25 (also answering 2025-06-18 and 2025-03-26 clients), basic and
// transports sections. Not reachable from the build session (UNCHECKED against the live site);
// versions checked against @modelcontextprotocol/sdk 1.32.2's LATEST_PROTOCOL_VERSION.
//   - POST /mcp: one JSON-RPC message. A request gets `application/json`; a notification or a
//     response gets 202 with no body.
//   - GET /mcp: 405, since this server never opens an SSE stream (allowed by the spec).
//   - DELETE /mcp: 405, since there are no sessions to end.
//   - `MCP-Protocol-Version` on a request after initialize: 400 when it names a version not served.

import { z } from "zod";

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export const LATEST_PROTOCOL_VERSION = PROTOCOL_VERSIONS[0];

/** JSON-RPC and MCP error codes. */
export const RPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolResult {
  content: Content[];
  isError?: boolean;
}

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface Tool<Ctx> {
  name: string;
  title: string;
  description: string;
  input: z.ZodObject;
  annotations: ToolAnnotations;
  run(ctx: Ctx, args: Record<string, unknown>): Promise<ToolResult>;
}

export interface ServerInfo {
  name: string;
  title: string;
  version: string;
}

export interface McpServer<Ctx> {
  info: ServerInfo;
  instructions: string;
  tools: readonly Tool<Ctx>[];
  /** Called around every tools/call (audit, errors). */
  call(tool: Tool<Ctx>, args: Record<string, unknown>): Promise<ToolResult>;
}

const Id = z.union([z.string(), z.number().int()]);
const Message = z.object({
  jsonrpc: z.literal("2.0"),
  id: Id.optional(),
  method: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});

type RpcResponse =
  | { jsonrpc: "2.0"; id: string | number; result: unknown }
  | {
      jsonrpc: "2.0";
      id: string | number | null;
      error: { code: number; message: string; data?: unknown };
    };

export const rpcError = (
  id: string | number | null,
  code: number,
  message: string,
): RpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/** The JSON Schema of a tool's input, as tools/list shows it. */
export function inputSchema(schema: z.ZodObject): Record<string, unknown> {
  const out = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<
    string,
    unknown
  >;
  delete out.$schema;
  return out;
}

export function listTools<Ctx>(tools: readonly Tool<Ctx>[]) {
  return tools.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: inputSchema(t.input),
    annotations: { title: t.title, ...t.annotations },
  }));
}

/** One JSON-RPC request → its response. */
export async function handleRequest<Ctx>(
  server: McpServer<Ctx>,
  id: string | number,
  method: string,
  params: Record<string, unknown>,
): Promise<RpcResponse> {
  switch (method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const protocolVersion = (PROTOCOL_VERSIONS as readonly string[]).includes(asked)
        ? asked
        : LATEST_PROTOCOL_VERSION;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: server.info,
          instructions: server.instructions,
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: listTools(server.tools) } };
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const tool = server.tools.find((t) => t.name === name);
      if (!tool) return rpcError(id, RPC.invalidParams, `no tool named ${name || "(none)"}`);
      const raw = params.arguments ?? {};
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return rpcError(id, RPC.invalidParams, "arguments must be an object");
      }
      return {
        jsonrpc: "2.0",
        id,
        result: await server.call(tool, raw as Record<string, unknown>),
      };
    }
    default:
      return rpcError(id, RPC.methodNotFound, `no method ${method}`);
  }
}

/** Streamable HTTP: one request in, one JSON answer out. Auth has already passed. */
export async function handleHttp<Ctx>(request: Request, server: McpServer<Ctx>): Promise<Response> {
  if (request.method === "GET" || request.method === "DELETE") {
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }
  const version = request.headers.get("mcp-protocol-version");
  if (version && !(PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
    return json(
      rpcError(null, RPC.invalidRequest, `protocol version ${version} is not supported`),
      400,
    );
  }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json(rpcError(null, RPC.parseError, "the body is not JSON"), 400);
  }
  if (Array.isArray(raw)) {
    return json(rpcError(null, RPC.invalidRequest, "batches are not supported"), 400);
  }
  const parsed = Message.safeParse(raw);
  if (!parsed.success) {
    return json(rpcError(null, RPC.invalidRequest, "not a JSON-RPC 2.0 message"), 400);
  }
  const message = parsed.data;
  // A notification (no id) or a client's response to us: accepted, nothing to answer.
  if (message.id === undefined || message.method === undefined) {
    return new Response(null, { status: 202 });
  }
  return json(await handleRequest(server, message.id, message.method, message.params ?? {}));
}
