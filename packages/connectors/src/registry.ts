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

/**
 * The connectors this deployment offers, keyed by manifest id. `apps/api` builds it at startup
 * from its list of connectors; the agents' tool registry reads `toolSpecs()` from it.
 */
export class ConnectorRegistry {
  private readonly byId = new Map<string, Connector>();
  private readonly toolIndex = new Map<string, { connector: Connector; spec: ToolSpec }>();

  constructor(connectors: Iterable<Connector> = []) {
    for (const c of connectors) this.register(c);
  }

  register(connector: Connector): this {
    const id = connector.manifest.id;
    const problems: string[] = [];
    if (this.byId.has(id)) problems.push("already registered");
    for (const spec of connector.manifest.tools) {
      if (this.toolIndex.has(spec.id)) problems.push(`tool ${spec.id} is already registered`);
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
    for (const spec of connector.manifest.tools) this.toolIndex.set(spec.id, { connector, spec });
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

  /** Every connector tool's spec, for the tool registry, the Builder and the publish check. */
  toolSpecs(): ToolSpec[] {
    return [...this.toolIndex.values()].map((t) => t.spec);
  }

  findTool(
    toolId: string,
  ): { connector: Connector; spec: ToolSpec; handler: ToolHandler } | undefined {
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
