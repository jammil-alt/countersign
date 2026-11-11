// Fetch on intent (docs/audit-plan.md 1.6): the first call of the page a link opens.
import { describe, expect, it } from "vitest";
import { apiRoutes } from "../../api/routes";
import { prefetchPage } from "./prefetch";

const ID = "00000000-0000-4000-8000-00000000f001";

function asked(to: string) {
  const calls: [unknown, unknown][] = [];
  const known = prefetchPage(
    ((route: unknown, options: unknown) => {
      calls.push([route, options]);
    }) as Parameters<typeof prefetchPage>[0],
    to,
  );
  return { known, calls };
}

describe("prefetchPage", () => {
  it("asks for the run page's, an agent's and a client's first call, as the page does", () => {
    expect(asked(`/ops/runs/${ID}`).calls).toEqual([[apiRoutes.opsRun, { params: { id: ID } }]]);
    expect(asked(`/ops/agents/${ID}`).calls).toEqual([
      [apiRoutes.opsAgent, { params: { id: ID } }],
    ]);
    expect(asked(`/ops/clients/${ID}/connections?x=1`).calls).toEqual([
      [apiRoutes.opsClient, { params: { id: ID } }],
    ]);
  });

  it("asks nothing for a page it does not know", () => {
    for (const to of ["/ops/runs", "/ops/clients/new", "/ops/agents/x/merge", "/ops/inbox"]) {
      expect(asked(to)).toEqual({ known: false, calls: [] });
    }
  });
});
