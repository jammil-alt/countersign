import { it } from "vitest";
import { createPlatform, deploymentConnectors } from "../platform";

type S = { properties?: Record<string, S>; items?: S; anyOf?: S[]; oneOf?: S[]; allOf?: S[]; $ref?: string; type?: unknown };
function has(schema: S | undefined, path: string): boolean {
  if (!schema) return false;
  const [head, ...rest] = path.split(".");
  const alts = [schema, ...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...(schema.allOf ?? [])];
  for (const s of alts) {
    if (/^\d+$/.test(head ?? "") && s.items) {
      if (rest.length === 0 || has(s.items, rest.join("."))) return true;
    }
    const p = s.properties?.[head ?? ""];
    if (p && (rest.length === 0 || has(p, rest.join(".")))) return true;
  }
  return false;
}
it("explore", () => {
  // biome-ignore lint/suspicious/noExplicitAny: exploring
  const p = createPlatform({ connectors: deploymentConnectors({} as any, false) as any });
  const out: string[] = [];
  for (const t of p.tools.list()) {
    const s = t.spec as unknown as { input: S; amount?: { path: string; currencyPath?: string }; recipient?: { path: string }; fixedInputs?: string[]; entityInput?: { field: string }; display?: unknown };
    const check = (what: string, path: string | undefined) => {
      if (path && !has(s.input, path)) out.push(`${t.spec.id} ${what} ${path}`);
    };
    check("amount", s.amount?.path);
    check("currencyPath", s.amount?.currencyPath);
    check("recipient", s.recipient?.path);
    for (const f of s.fixedInputs ?? []) check("fixed", f);
    check("entityInput", s.entityInput?.field);
  }
  console.log(p.tools.list().length, `\n${out.join("\n")}`);
});
