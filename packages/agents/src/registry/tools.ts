// The tool registry (ARCHITECTURE §9.4): every tool an agent may be given, from three sources: the
// platform's own list, each registered connector's manifest, and each pack's manifest. apps/api
// builds it at startup; nothing here names a pack (CLAUDE.md invariant 2).

import { bindingKeyFor, type Connector, ConnectorRegistry } from "@countersign/connectors";
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
      for (const spec of connector.manifest.tools) {
        // v0.14 W4-A: a shared id another connector supplies too (the connector registry checked
        // the namespace and the shapes) is registered once; the agent's binding picks the
        // connector at each call (`resolve`).
        const first = this.byId.get(spec.id);
        if (
          first?.kind === "connector" &&
          first.connector !== connector &&
          this.connectors.providersOf(spec.id).includes(connector)
        ) {
          continue;
        }
        add({ kind: "connector", spec, connector });
      }
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

  /**
   * Every spec by id: the `tools` registry of core's TypingContext / ValidationContext.
   * v0.14 W4-A: given a client agent's bindings, a shared id's spec is the bound connector's (its
   * `connector` is the one publishing checks the matrix of).
   */
  specs(bindings?: Readonly<Record<string, string>>): Record<string, ToolSpec> {
    return Object.fromEntries(
      [...this.byId].map(([id, t]) => [
        id,
        bindings && t.kind === "connector"
          ? (this.forConnector(id, this.connectorFor(id, bindings)) ?? t).spec
          : t.spec,
      ]),
    );
  }

  // ── v0.14 W4-A: shared ids (docs/plan.md §1.57) ────────────────────────────────────────────────

  /** The connectors that supply a tool id (one for most; Twilio and Meta for `whatsapp.send`). */
  providers(id: string): readonly Connector[] {
    return this.connectors.providersOf(id);
  }

  /** The tool as one connector supplies it, or undefined when that connector doesn't. */
  forConnector(id: string, connectorId: string): RegisteredTool | undefined {
    const hit = this.connectors.findTool(id, connectorId);
    return hit ? { kind: "connector", spec: hit.spec, connector: hit.connector } : undefined;
  }

  /**
   * The connector a bundle needs bound for a tool: the one of its suppliers the bindings name
   * (the first such), else the first registered (Twilio for the messaging ids).
   */
  connectorFor(id: string, bindings: Readonly<Record<string, string>> = {}): string {
    const providers = this.providers(id);
    const bound = providers.find((c) => bindings[c.manifest.id] !== undefined);
    return (bound ?? providers[0])?.manifest.id ?? id.split(".")[0] ?? id;
  }

  /**
   * Which connector answers a call to a connector tool for this agent. One supplier: that one.
   * Several: those the agent is bound to (by binding key), less those that don't take this input;
   * still several, the one the agent's channel for the call (`whatsapp`, `sms`) is bound to.
   * Otherwise the call is refused, naming what to bind.
   */
  // DECISION: never a silent default between providers: a call that can't be told apart is
  // refused rather than sent through whichever registered first.
  resolve(
    id: string,
    agent: {
      bindings: Readonly<Record<string, string>>;
      channels?: Readonly<Record<string, string>> | undefined;
    },
    input: unknown,
  ): RegisteredTool | { refused: string } {
    const tool = this.get(id);
    if (tool?.kind !== "connector") return tool ?? { refused: `no tool ${id}` };
    const providers = this.providers(id);
    if (providers.length <= 1) return tool;
    const bound = providers.filter((c) => {
      const key = bindingKeyFor(c, input);
      return key !== null && agent.bindings[key] !== undefined;
    });
    if (bound.length === 0) {
      return {
        refused: `no ${providers.map((c) => c.manifest.id).join(" or ")} connection is bound`,
      };
    }
    const taking = bound.filter((c) => {
      try {
        return c.handlesInput?.(id, input) ?? true;
      } catch {
        return false;
      }
    });
    if (taking.length === 0) {
      return { refused: `none of the connections bound for ${id} takes this input` };
    }
    let picked = taking.length === 1 ? taking[0] : undefined;
    const channel = callChannel(tool.spec, input);
    if (!picked && channel) {
      const connectionId = agent.channels?.[channel];
      picked = connectionId
        ? taking.find((c) => agent.bindings[bindingKeyFor(c, input) ?? ""] === connectionId)
        : undefined;
    }
    if (!picked) {
      return {
        refused: `more than one connection can answer ${id}; set the agent's ${channel ?? "message"} channel to choose one`,
      };
    }
    return this.forConnector(id, picked.manifest.id) ?? tool;
  }
}

/** The messaging channel a call is on: the send's recipient's, the input's, else the tool's namespace. */
function callChannel(spec: ToolSpec, input: unknown): "sms" | "whatsapp" | null {
  const fromSpec = spec.recipient?.channel;
  if (fromSpec === "sms" || fromSpec === "whatsapp") return fromSpec;
  const c =
    input && typeof input === "object" ? (input as { channel?: unknown }).channel : undefined;
  if (c === "sms" || c === "whatsapp") return c;
  const ns = spec.id.split(".")[0];
  return ns === "sms" || ns === "whatsapp" ? ns : null;
}
