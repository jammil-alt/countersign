import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { Columns, Loaded, Page, PageGrid, Section } from "./page";
import { Card, PageHeader } from "./primitives";

describe("page layout", () => {
  it("lays out a page with a header, a section, a grid and a rail", () => {
    render(
      <Page testId="page">
        <PageHeader
          eyebrow="Thursday, November 5"
          title="Good morning, Dana"
          subtitle="Five things wait on you."
          actions={<button type="button">Ask</button>}
        />
        <PageGrid rail={<p>Waiting on you</p>}>
          <Section title="Working now" meta="3 running" testId="section">
            <Columns count={2}>
              <p>one</p>
              <p>two</p>
            </Columns>
          </Section>
        </PageGrid>
      </Page>,
    );
    expect(screen.getByTestId("page")).toHaveClass("ui-page");
    expect(screen.getByText("Thursday, November 5")).toHaveClass("eyebrow");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Good morning, Dana");
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Working now");
    expect(screen.getByText("3 running")).toBeInTheDocument();
    expect(screen.getByRole("complementary")).toHaveTextContent("Waiting on you");
    expect(screen.getByText("one").parentElement).toHaveClass("ui-cols", "ui-cols--2");
  });

  it("gives a card a head, a padded body and a foot", () => {
    render(
      <Card title="About this run" meta="All" footer={<button type="button">Open</button>} pad>
        <p>body</p>
      </Card>,
    );
    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent("About this run");
    expect(screen.getByText("All").parentElement).toHaveClass("ui-card__head");
    expect(screen.getByText("body").parentElement).toHaveClass("ui-card__body");
    expect(screen.getByRole("button", { name: "Open" }).parentElement).toHaveClass("ui-card__foot");
  });
});

describe("Loaded", () => {
  it("shows loading, then the data", () => {
    const { rerender } = render(
      <Loaded state={{ data: undefined, error: null, loading: true, reload: () => {} }}>
        {(d: string) => <p>{d}</p>}
      </Loaded>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
    rerender(
      <Loaded state={{ data: "ready", error: null, loading: false, reload: () => {} }}>
        {(d: string) => <p>{d}</p>}
      </Loaded>,
    );
    expect(screen.getByText("ready")).toBeInTheDocument();
  });

  it("shows the error with Try again", async () => {
    const reload = vi.fn();
    render(
      <Loaded
        state={{
          data: undefined,
          error: new ApiError({
            status: 500,
            code: "http_500",
            message: "boom",
            route: "GET /api/x",
          }),
          loading: false,
          reload,
        }}
      >
        {(d: string) => <p>{d}</p>}
      </Loaded>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reload).toHaveBeenCalled();
  });
});
