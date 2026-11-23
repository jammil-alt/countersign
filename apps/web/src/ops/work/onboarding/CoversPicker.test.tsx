// S6.7 (TP1): the invite's "Agents" offers a template only once it has a published version (a
// fork of a draft is refused); one already chosen stays shown so it can be taken off.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApiProvider } from "../../../api/useApi";
import { AGENT_SUMMARY, fakeApi } from "../../../test/fixtures";
import { CoversPicker } from "./parts";

const template = (n: number, liveVersionId: string | null) => ({
  ...AGENT_SUMMARY,
  id: `00000000-0000-4000-8000-00000000f00${n}`,
  kind: "template" as const,
  tenantId: null,
  slug: `t${n}`,
  name: `Template ${n}`,
  serviceName: null,
  liveVersionId,
});

const PUBLISHED = template(1, "00000000-0000-4000-8000-00000000e001");
const DRAFT = template(2, null);
const CHOSEN_DRAFT = template(3, null);

describe("the invite's agents", () => {
  it("offers published templates, and keeps one already chosen", async () => {
    const api = fakeApi({
      "GET /api/ops/templates": () => ({ templates: [PUBLISHED, DRAFT, CHOSEN_DRAFT] }),
    });
    render(
      <ApiProvider client={api.client}>
        <CoversPicker
          value={{ general: true, areas: [], templateIds: [CHOSEN_DRAFT.id] }}
          onChange={() => {}}
        />
      </ApiProvider>,
    );
    expect(await screen.findByTestId(`covers-template-${PUBLISHED.id}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`covers-template-${DRAFT.id}`)).toBeNull();
    expect(screen.getByTestId(`covers-template-${CHOSEN_DRAFT.id}`)).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });
});
