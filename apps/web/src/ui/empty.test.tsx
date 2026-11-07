// EmptyState (a short line, an optional title and an optional action, as before with children) and
// SubTabs (a tab's own pages, as the Segmented with links).
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { EmptyState, SubTabs } from "./primitives";

describe("EmptyState", () => {
  it("still takes its line as children", () => {
    render(<EmptyState>No runs yet.</EmptyState>);
    expect(screen.getByText("No runs yet.").closest(".ds-empty")).not.toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows a title, the line and a link to where it fills", () => {
    render(
      <MemoryRouter>
        <EmptyState
          title="No agents"
          line="Fork a template into this client."
          action={{ label: "New agent", to: "/ops/clients/a/agents/new", testId: "go" }}
          testId="empty"
        />
      </MemoryRouter>,
    );
    const empty = screen.getByTestId("empty");
    expect(empty).toHaveClass("ds-empty");
    expect(empty).toHaveTextContent("No agentsFork a template into this client.New agent");
    expect(screen.getByTestId("go")).toHaveAttribute("href", "/ops/clients/a/agents/new");
    expect(screen.getByTestId("go")).toHaveClass("ds-btn", "ds-btn--secondary", "ds-btn--sm");
  });

  it("or a button", async () => {
    const onClick = vi.fn();
    render(<EmptyState line="Nothing matches." action={{ label: "Clear the search", onClick }} />);
    await userEvent.click(screen.getByRole("button", { name: "Clear the search" }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe("SubTabs", () => {
  it("links each page and marks the current one", () => {
    render(
      <MemoryRouter>
        <SubTabs
          label="Data"
          items={[
            { to: "/d", label: "Documents", active: false },
            { to: "/r", label: "Records", active: true },
          ]}
        />
      </MemoryRouter>,
    );
    const nav = screen.getByRole("navigation", { name: "Data" });
    expect(nav).toHaveClass("ds-seg");
    expect(screen.getByRole("link", { name: "Records" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Documents" })).not.toHaveAttribute("aria-current");
  });
});
