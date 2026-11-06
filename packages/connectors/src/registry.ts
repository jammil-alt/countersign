import type { ConnectorManifest, ToolSpec } from "@countersign/core";
import type { Connector, ToolHandler } from "./connector";
import { ConnectorDefinitionError } from "./connector";
import { manifestDefaultProblems } from "./permissions";

export class UnknownConnectorError extends Error {
  constructor(readonly connectorId: string) {
    super(`unknown connector: ${connectorId}`);
    this.name = "UnknownConnectorError";
  }
}

export class UnknownToolError extends Error {
  constructor(readonly toolId: string) {
    super(`unknown connector tool: ${toolId}`);
    this.name = "UnknownToolError";
  }
}

// v0.14 W4-A (docs/plan.md §1.57): a tool id in a shared namespace (`whatsapp.send`,
// `message.get`) may be supplied by several connectors (Twilio and Meta), as long as each declares
// that namespace and the tools take and give exactly the same shapes, so a workflow names one id
// and the agent's binding decides which connector answers it. Every other id is still refused
// when registered twice.
/** The parts of a tool's spec every connector that supplies one shared id must agree on. */
export function sharedToolShape(spec: ToolSpec): string {
  return JSON.stringify([
    spec.input,
    spec.output,
    spec.sideEffect,
    spec.verb,
    spec.entity ?? null,
    spec.entityInput ?? null,
    spec.recipient ?? null,
    spec.fixedInputs ?? null,
    spec.amount ?? null,
    spec.display ?? null,
  ]);
}

/** Whether `toolId` is in a shared namespace this connector declares (not its own id's). */
function inSharedNamespace(connector: Connector, toolId: string): boolean {
  const ns = toolId.split(".")[0] ?? "";
  return ns !== connector.manifest.id && (connector.manifest.sharedNamespaces ?? []).includes(ns);
}

/**
 * The connectors this deployment offers, keyed by manifest id. `apps/api` builds it at startup
 * from its list of connectors; the agents' tool registry reads `toolSpecs()` from it.
 */
export class ConnectorRegistry {
  private readonly byId = new Map<string, Connector>();
  private readonly toolIndex = new Map<string, { connector: Connector; spec: ToolSpec }>();
  // v0.14 W4-A: every connector that supplies a tool id, in registration order.
  private readonly providerIndex = new Map<string, Connector[]>();

  constructor(connectors: Iterable<Connector> = []) {
    for (const c of connectors) this.register(c);
  }

  register(connector: Connector): this {
    const id = connector.manifest.id;
    const problems: string[] = [];
    if (this.byId.has(id)) problems.push("already registered");
    for (const spec of connector.manifest.tools) {
      const existing = this.toolIndex.get(spec.id);
      if (existing) {
        // v0.14 W4-A: allowed only in a namespace both share, with the same shapes.
        const shared =
          inSharedNamespace(connector, spec.id) &&
          inSharedNamespace(existing.connector, spec.id) &&
          sharedToolShape(existing.spec) === sharedToolShape(spec);
        if (!shared) problems.push(`tool ${spec.id} is already registered`);
      }
      if (!connector.tools[spec.id]) problems.push(`tool ${spec.id} has no handler`);
    }
    for (const toolId of Object.keys(connector.tools)) {
      if (!connector.manifest.tools.some((t) => t.id === toolId)) {
        problems.push(`handler ${toolId} is not in the manifest`);
      }
    }
    problems.push(...manifestDefaultProblems(connector.manifest));
    if (problems.length > 0) throw new ConnectorDefinitionError(id, problems);
    this.byId.set(id, connector);
    for (const spec of connector.manifest.tools) {
      if (!this.toolIndex.has(spec.id)) this.toolIndex.set(spec.id, { connector, spec });
      this.providerIndex.set(spec.id, [...(this.providerIndex.get(spec.id) ?? []), connector]);
    }
    return this;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  get(id: string): Connector | undefined {
    return this.byId.get(id);
  }

  require(id: string): Connector {
    const c = this.byId.get(id);
    if (!c) throw new UnknownConnectorError(id);
    return c;
  }

  list(): Connector[] {
    return [...this.byId.values()];
  }

  manifests(): ConnectorManifest[] {
    return this.list().map((c) => c.manifest);
  }

  /** Every connector tool's spec (one per id: the first connector's), for the tool registry. */
  toolSpecs(): ToolSpec[] {
    return [...this.toolIndex.values()].map((t) => t.spec);
  }

  /** v0.14 W4-A: the connectors that supply a tool id, in registration order. */
  providersOf(toolId: string): readonly Connector[] {
    return this.providerIndex.get(toolId) ?? [];
  }

  /**
   * A tool's connector, spec and handler: the named connector's (v0.14 W4-A: for a shared id),
   * else the first connector that registered it.
   */
  findTool(
    toolId: string,
    connectorId?: string,
  ): { connector: Connector; spec: ToolSpec; handler: ToolHandler } | undefined {
    if (connectorId !== undefined) {
      const connector = this.providersOf(toolId).find((c) => c.manifest.id === connectorId);
      const spec = connector?.manifest.tools.find((t) => t.id === toolId);
      const handler = connector?.tools[toolId];
      return connector && spec && handler ? { connector, spec, handler } : undefined;
    }
    const hit = this.toolIndex.get(toolId);
    if (!hit) return undefined;
    const handler = hit.connector.tools[toolId];
    return handler ? { ...hit, handler } : undefined;
  }

  requireTool(toolId: string): { connector: Connector; spec: ToolSpec; handler: ToolHandler } {
    const hit = this.findTool(toolId);
    if (!hit) throw new UnknownToolError(toolId);
    return hit;
  }
}
