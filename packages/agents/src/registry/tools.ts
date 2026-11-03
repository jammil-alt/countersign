// The tool registry (ARCHITECTURE §9.4): every tool an agent may be given, from three sources: the
// platform's own list, each registered connector's manifest, and each pack's manifest. apps/api
// builds it at startup; nothing here names a pack (CLAUDE.md invariant 2).

import { type Connector, ConnectorRegistry } from "@countersign/connectors";
import { type PackManifest, type ToolSpec, ToolSpec as ToolSpecSchema } from "@countersign/core";
import type { InternalTool } from "../tools/types";

export type RegisteredTool =
  | { kind: "internal"; spec: ToolSpec; tool: InternalTool }
  | { kind: "connector"; spec: ToolSpec; connector: Connector };

/** A pack's tools: its manifest plus handlers (apps/api adapts the pack's exports to this shape). */
export interface PackToolSource {
  manifest: Pick<PackManifest, "id" | "tools">;
  handlers: Readonly<Record<string, InternalTool>>;
}

export class ToolRegistryError extends Error {
  override name = "ToolRegistryError";
  constructor(readonly problems: string[]) {
    super(`tool registry: ${problems.join("; ")}`);
  }
}

export interface ToolRegistryOptions {
  platform?: readonly InternalTool[];
  connectors?: ConnectorRegistry;
  packs?: readonly PackToolSource[];
}

export class ToolRegistry {
  readonly connectors: ConnectorRegistry;
  private readonly byId = new Map<string, RegisteredTool>();

  constructor(options: ToolRegistryOptions = {}) {
    this.connectors = options.connectors ?? new ConnectorRegistry();
    const problems: string[] = [];
    const add = (entry: RegisteredTool) => {
      const parsed = ToolSpecSchema.safeParse(entry.spec);
      if (!parsed.success) {
        problems.push(`${entry.spec.id}: ${parsed.error.issues.map((i) => i.message).join(", ")}`);
        return;
      }
      if (this.byId.has(entry.spec.id)) problems.push(`${entry.spec.id} is registered twice`);
      this.byId.set(entry.spec.id, entry);
    };
    for (const tool of options.platform ?? []) {
      if (tool.spec.source !== "platform") problems.push(`${tool.spec.id}: source is not platform`);
      if (tool.spec.sideEffect === "external") {
        problems.push(`${tool.spec.id}: platform tools never write to a client's tool`);
      }
      add({ kind: "internal", spec: tool.spec, tool });
    }
    for (const connector of this.connectors.list()) {
      for (const spec of connector.manifest.tools) add({ kind: "connector", spec, connector });
    }
    for (const pack of options.packs ?? []) {
      for (const spec of pack.manifest.tools) {
        const tool = pack.handlers[spec.id];
        if (!tool) {
          problems.push(`${spec.id}: pack ${pack.manifest.id} has no handler for it`);
          continue;
        }
        // DECISION: writes to a client's tool go through connectors only, so every external write
        // has a connection, a matrix and a before snapshot. Pack tools are `none` or `internal`.
        if (spec.sideEffect === "external") {
          problems.push(
            `${spec.id}: pack tools are 'none' or 'internal'; writes go via connectors`,
          );
          continue;
        }
        add({ kind: "internal", spec, tool });
      }
    }
    if (problems.length > 0) throw new ToolRegistryError(problems);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  get(id: string): RegisteredTool | undefined {
    return this.byId.get(id);
  }

  list(): RegisteredTool[] {
    return [...this.byId.values()];
  }

  /** Every spec by id: the `tools` registry of core's TypingContext / ValidationContext. */
  specs(): Record<string, ToolSpec> {
    const out: Record<string, ToolSpec> = {};
    for (const [id, t] of this.byId) out[id] = t.spec;
    return out;
  }
}
