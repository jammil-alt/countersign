// A translated sentence with styled parts (docs/plan.md §1.18): the words come from the message
// file, so each language orders them its own way, and `{name}` placeholders become React nodes.
import { Fragment, type ReactNode } from "react";

/**
 * `text` is a message rendered with its placeholders kept, e.g.
 * `t("billing.meter.used", { used: "{used}", allowance: "{allowance}" })`; each `{name}` found in
 * `nodes` becomes that node, everything else stays text.
 */
export function richText(text: string, nodes: Record<string, ReactNode>): ReactNode {
  const parts = text.split(/(\{\w+\})/g);
  return parts.map((part, i) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    const node = name !== undefined && name in nodes ? nodes[name] : part;
    // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one sentence never reorder.
    return <Fragment key={i}>{node}</Fragment>;
  });
}
