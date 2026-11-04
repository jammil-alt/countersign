// The sign-in page shows the sign-in the API names: WorkOS (a button to the API's sign-in route,
// carrying `next`, and the reason a sign-in failed), or the development sign-in.
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ApiProvider } from "../api/useApi";
import { fakeApi, Reply } from "../test/fixtures";
import { SignInScreen, signInErrorText } from "./SignIn";
import { SessionProvider } from "./session";

function renderAt(path: string, provider: "workos" | "dev" | "unavailable") {
  const api = fakeApi({
    "GET /api/session": () => new Reply(401, { error: { code: "unauthenticated" } }),
    "GET /api/auth/provider": () => ({ provider, message: null }),
    "GET /api/auth/dev/users": () => ({ users: [] }),
  });
  render(
    <MemoryRouter initialEntries={[path]}>
      <ApiProvider client={api.client}>
        <SessionProvider>
          <SignInScreen />
        </SessionProvider>
      </ApiProvider>
    </MemoryRouter>,
  );
  return api;
}

describe("sign-in page", () => {
  it("with WorkOS, links to the API's sign-in and carries where to go back to", async () => {
    const api = renderAt("/sign-in?next=%2Fops%2Fclients", "workos");
    const link = await screen.findByTestId("signin-workos");
    expect(link.getAttribute("href")).toBe("/api/auth/sign-in?return_to=%2Fops%2Fclients");
    expect(screen.queryByTestId("signin-email-input")).toBeNull();
    expect(api.calls).not.toContain("GET /api/auth/dev/users");
  });

  it("never carries an off-site next, and says why a sign-in failed", async () => {
    renderAt("/sign-in?next=%2F%2Fevil.example&error=not_invited", "workos");
    const link = await screen.findByTestId("signin-workos");
    expect(link.getAttribute("href")).toBe("/api/auth/sign-in");
    expect((await screen.findByTestId("signin-error")).textContent).toContain("not been invited");
  });

  it("shows the development sign-in with the dev adapter", async () => {
    renderAt("/sign-in", "dev");
    expect(await screen.findByTestId("signin-email-input")).toBeTruthy();
    expect(screen.queryByTestId("signin-workos")).toBeNull();
  });

  it("turns error codes into words, with a fallback for unknown ones", () => {
    expect(signInErrorText(null)).toBeNull();
    expect(signInErrorText("email_not_verified")).toMatch(/Verify your email/);
    expect(signInErrorText("<script>")).toBe("Sign-in did not finish. Start again.");
  });
});
