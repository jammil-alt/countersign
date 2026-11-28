// Describe it (F5): Draft the workflow starts the build and drafts it from the words, in that
// order, saying so while it runs, then opens the draft's workflow as its list of steps (owner,
// 2026-11-26: no Check the steps in between); List the steps myself starts the build only and
// opens Check the steps to type into; a client agent names its client.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ApiProvider } from "../../api/useApi";
import { fakeApi, Reply } from "../../test/fixtures";
import { BUILD_ID, buildDetail, DRAFT_AGENT_ID } from "./checkFixtures";
import { DescribeScreen, type DescribeScreenProps } from "./DescribeScreen";

function Check() {
  const state = useLocation().state as { words?: string } | null;
  return <p data-testid="check-page">{state?.words ?? ""}</p>;
}

function Steps() {
  return <p data-testid="steps-page">{useLocation().pathname}</p>;
}

function renderDescribe(api: ReturnType<typeof fakeApi>, props: Partial<DescribeScreenProps> = {}) {
  render(
    <MemoryRouter initialEntries={["/ops/lab"]}>
      <ApiProvider client={api.client}>
        <Routes>
          <Route path="/ops/lab" element={<DescribeScreen kind="template" {...props} />} />
          <Route path="/ops/lab/check/:id" element={<Check />} />
          <Route path="/ops/agents/:id/steps" element={<Steps />} />
        </Routes>
      </ApiProvider>
    </MemoryRouter>,
  );
  return userEvent.setup();
}

const WORDS =
  "When a vendor invoice arrives by email, read it. If it is a duplicate, tell Dana and stop.";

describe("Describe it", () => {
  it("starts the build, then drafts it from the words, then opens its steps to edit", async () => {
    const bodies: unknown[] = [];
    let release: () => void = () => {};
    const api = fakeApi({
      "POST /api/ops/builds": ({ init }) => {
        bodies.push(JSON.parse(String(init.body)));
        return buildDetail();
      },
      [`POST /api/ops/builds/${BUILD_ID}/draft-now`]: ({ init }) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Promise((done) => {
          release = () => done(buildDetail({ agentId: DRAFT_AGENT_ID, words: WORDS }));
        });
      },
    });
    const user = renderDescribe(api);
    expect(screen.getByTestId("flow-stepper")).toHaveTextContent(
      "1Describe it2Edit the steps3Try and publish",
    );
    expect(screen.getByRole("heading", { name: "What should it do?" })).toBeInTheDocument();
    // Nothing to start from yet.
    expect(screen.getByTestId("flow-describe-draft")).toBeDisabled();
    expect(screen.getByTestId("flow-describe-mine")).toBeDisabled();
    await user.type(screen.getByTestId("flow-describe-name"), "Invoice intake");
    // A name alone lists the steps by hand; drafting needs the words.
    expect(screen.getByTestId("flow-describe-mine")).toBeEnabled();
    expect(screen.getByTestId("flow-describe-draft")).toBeDisabled();
    await user.type(screen.getByTestId("flow-describe-words"), WORDS);
    await user.click(screen.getByTestId("flow-describe-draft"));
    expect(await screen.findByTestId("flow-describe-drafting")).toHaveTextContent(
      "Reading it and drafting the steps",
    );
    // The wait says what the one call does and how long it has been, with no made-up stages.
    expect(screen.getByTestId("flow-describe-drafting")).toHaveTextContent(
      "picks a skill or a tool for each",
    );
    expect(screen.getByTestId("flow-describe-clock")).toHaveTextContent("0:0");
    release();
    expect(await screen.findByTestId("steps-page")).toHaveTextContent(
      `/ops/agents/${DRAFT_AGENT_ID}/steps`,
    );
    expect(api.calls).toEqual([
      "POST /api/ops/builds",
      `POST /api/ops/builds/${BUILD_ID}/draft-now`,
    ]);
    expect(bodies).toEqual([{ kind: "agent", title: "Invoice intake" }, { description: WORDS }]);
  });

  it("names it from the words when the name is left empty, and the name can be changed", async () => {
    const bodies: unknown[] = [];
    const api = fakeApi({
      "POST /api/ops/assist/draft": ({ init }) => {
        bodies.push(JSON.parse(String(init.body)));
        return { text: "“Invoice intake.”" };
      },
      "POST /api/ops/builds": ({ init }) => {
        bodies.push(JSON.parse(String(init.body)));
        return buildDetail();
      },
      [`POST /api/ops/builds/${BUILD_ID}/draft-now`]: () =>
        buildDetail({ agentId: DRAFT_AGENT_ID, words: WORDS }),
    });
    const user = renderDescribe(api);
    expect(screen.getByTestId("flow-describe")).toHaveTextContent(
      "Leave it empty and we name it from your words.",
    );
    await user.type(screen.getByTestId("flow-describe-words"), WORDS);
    // Leaving the words names it, in the field, as a name: no quotation marks, no full stop.
    await user.tab();
    await waitFor(() =>
      expect(screen.getByTestId("flow-describe-name")).toHaveDisplayValue("Invoice intake"),
    );
    expect(bodies[0]).toEqual({ field: "build.name", notes: WORDS, context: {} });
    expect(screen.getByTestId("flow-describe")).toHaveTextContent("Named from your words.");
    // It is theirs to change, and a name someone typed is never replaced.
    await user.type(screen.getByTestId("flow-describe-name"), " by email");
    await user.click(screen.getByTestId("flow-describe-words"));
    await user.tab();
    await user.click(screen.getByTestId("flow-describe-draft"));
    await screen.findByTestId("steps-page");
    expect(api.calls.filter((c) => c === "POST /api/ops/assist/draft")).toHaveLength(1);
    expect(bodies[1]).toEqual({ kind: "agent", title: "Invoice intake by email" });
  });

  it("names it on the way when Draft the workflow is pressed with no name", async () => {
    const titles: unknown[] = [];
    const api = fakeApi({
      "POST /api/ops/assist/draft": () => ({ text: "Invoice intake" }),
      "POST /api/ops/builds": ({ init }) => {
        titles.push(JSON.parse(String(init.body)).title);
        return buildDetail();
      },
      [`POST /api/ops/builds/${BUILD_ID}/draft-now`]: () =>
        buildDetail({ agentId: DRAFT_AGENT_ID, words: WORDS }),
    });
    const user = renderDescribe(api, { initialWords: WORDS });
    await user.click(screen.getByTestId("flow-describe-draft"));
    await screen.findByTestId("steps-page");
    // One name, made once, then the build with it.
    expect(api.calls).toEqual([
      "POST /api/ops/assist/draft",
      "POST /api/ops/builds",
      `POST /api/ops/builds/${BUILD_ID}/draft-now`,
    ]);
    expect(titles).toEqual(["Invoice intake"]);
  });

  it("asks for a typed name when it can't be named", async () => {
    const api = fakeApi({
      "POST /api/ops/assist/draft": () =>
        new Reply(502, { error: { code: "model_failed", message: "the model failed" } }),
    });
    const user = renderDescribe(api, { initialWords: WORDS });
    await user.click(screen.getByTestId("flow-describe-words"));
    await user.tab();
    await waitFor(() =>
      expect(screen.getByTestId("flow-describe")).toHaveTextContent(
        "We couldn't name it from your words. Type a name.",
      ),
    );
    expect(api.calls).toEqual(["POST /api/ops/assist/draft"]);
  });

  it("drafts the same build again after a failed draft", async () => {
    let tries = 0;
    const api = fakeApi({
      "POST /api/ops/builds": () => buildDetail(),
      [`POST /api/ops/builds/${BUILD_ID}/draft-now`]: () => {
        tries += 1;
        return tries === 1
          ? new Reply(502, { error: { code: "builder_failed", message: "the Builder failed" } })
          : buildDetail({ agentId: DRAFT_AGENT_ID, words: WORDS });
      },
    });
    const user = renderDescribe(api, { initialName: "Invoice intake", initialWords: WORDS });
    await user.click(screen.getByTestId("flow-describe-draft"));
    await waitFor(() => expect(screen.getByTestId("flow-describe-draft")).toBeEnabled());
    await user.click(screen.getByTestId("flow-describe-draft"));
    await screen.findByTestId("steps-page");
    expect(api.calls.filter((c) => c === "POST /api/ops/builds")).toHaveLength(1);
    expect(tries).toBe(2);
  });

  it("lists the steps by hand: the build starts with no draft and Check the steps opens", async () => {
    const bodies: unknown[] = [];
    const api = fakeApi({
      "POST /api/ops/builds": ({ init }) => {
        bodies.push(JSON.parse(String(init.body)));
        return buildDetail({ clientId: "00000000-0000-4000-8000-00000000a001" });
      },
    });
    const user = renderDescribe(api, {
      kind: "client",
      clientId: "00000000-0000-4000-8000-00000000a001",
    });
    await user.type(screen.getByTestId("flow-describe-name"), "Bill review");
    await user.click(screen.getByTestId("flow-describe-mine"));
    await screen.findByTestId("check-page");
    expect(api.calls).toEqual(["POST /api/ops/builds"]);
    expect(bodies).toEqual([
      { kind: "agent", title: "Bill review", clientId: "00000000-0000-4000-8000-00000000a001" },
    ]);
  });

  it("drafts a build started before in place", async () => {
    const api = fakeApi({
      [`POST /api/ops/builds/${BUILD_ID}/draft-now`]: () =>
        buildDetail({ agentId: DRAFT_AGENT_ID, words: WORDS }),
    });
    const user = renderDescribe(api, {
      initialName: "Invoice intake",
      initialWords: WORDS,
      buildId: BUILD_ID,
    });
    await user.click(screen.getByTestId("flow-describe-draft"));
    await screen.findByTestId("steps-page");
    expect(api.calls).toEqual([`POST /api/ops/builds/${BUILD_ID}/draft-now`]);
  });

  it("keeps the buttons off while something above is unsettled", () => {
    renderDescribe(fakeApi({}), {
      kind: "client",
      blocked: true,
      initialName: "Bill review",
      initialWords: WORDS,
    });
    expect(screen.getByTestId("flow-describe-draft")).toBeDisabled();
    expect(screen.getByTestId("flow-describe-mine")).toBeDisabled();
  });
});
