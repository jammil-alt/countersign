// The Steps tab (docs/plan.md §1.108) marks a step that requires code with its Dev queue request's
// status, pulled from the queue (§1.125), and links to the request.
import type { processes, StepCodeRequest } from "@countersign/core";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { StepsList, stepRows } from "./StepsList";

const workflow = {
  schemaVersion: 4,
  triggers: [{ id: "t", on: { type: "manual", input: {} } }],
  steps: [
    {
      id: "offset",
      name: "Offset the run date",
      kind: "missing",
      need: "Run date minus one month",
    },
    { id: "ratio", name: "Margin", kind: "missing", need: "Divide profit by revenue" },
  ],
} as unknown as processes.Process;

const request = (over: Partial<StepCodeRequest["request"]>): StepCodeRequest => ({
  buildId: "b1",
  workflowId: "monthly",
  stepId: "offset",
  request: {
    id: "r1",
    ref: "DQ-012",
    title: "Add date offsets to Reshape data",
    status: "in_progress",
    inReview: false,
    shippedStagingAt: null,
    ...over,
  },
});

describe("a step that requires code", () => {
  it("shows its request's status from the Dev queue, and links to it", () => {
    const rows = stepRows({
      workflow,
      errors: [],
      left: [],
      labels: {},
      requests: [request({})],
      slug: "monthly",
    });
    expect(rows[0]).toMatchObject({
      status: "Requires code · DQ-012 · In progress",
      detail: "Add date offsets to Reshape data",
      request: { ref: "DQ-012" },
    });
    // A step with no request stays missing.
    expect(rows[1]?.status).toBe("Missing");
    render(
      <MemoryRouter>
        <StepsList rows={rows} selectedId={null} onSelect={() => {}} />
      </MemoryRouter>,
    );
    expect(screen.getByText("Requires code · DQ-012 · In progress")).toBeTruthy();
    expect(screen.getByTestId("builder-steps-request-offset").getAttribute("href")).toBe(
      "/ops/utilities/feedback?tab=dev-queue&request=DQ-012",
    );
  });

  it("says In review with a PR, and asks for the swap once shipped", () => {
    const review = stepRows({
      workflow,
      errors: [],
      left: [],
      labels: {},
      requests: [request({ inReview: true })],
    });
    expect(review[0]?.status).toBe("Requires code · DQ-012 · In review");
    const shipped = stepRows({
      workflow,
      errors: [],
      left: [],
      labels: {},
      requests: [request({ status: "shipped" })],
    });
    expect(shipped[0]).toMatchObject({
      status: "Requires code · DQ-012 · Shipped",
      tone: "warning",
    });
    expect(shipped[0]?.detail).toMatch(/put it in this step/);
    // Another workflow's step of the same id isn't this one; a closed request no longer holds it.
    expect(
      stepRows({
        workflow,
        errors: [],
        left: [],
        labels: {},
        requests: [request({})],
        slug: "other",
      })[0]?.status,
    ).toBe("Missing");
    expect(
      stepRows({
        workflow,
        errors: [],
        left: [],
        labels: {},
        requests: [request({ status: "closed" })],
      })[0]?.status,
    ).toBe("Missing");
  });
});
