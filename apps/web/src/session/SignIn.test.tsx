// The sign-in page shows the sign-in the API names: WorkOS (straight on to the API's sign-in
// route, carrying `next`; the card only with the reason a sign-in failed), or the development
// sign-in.
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ApiProvider } from "../api/useApi";
import { fakeApi, Reply } from "../test/fixtures";
import { SignInScreen, signInErrorText } from "./SignIn";
import { SessionProvider } from "./session";

function renderAt(path: string, provider: "workos" | "dev" | "unavailable") {
  const go = vi.fn();
  const api = fakeApi({
    "GET /api/session": () => new Reply(401, { error: { code: "unauthenticated" } }),
    "GET /api/auth/provider": () => ({ provider, message: null }),
    "GET /api/auth/dev/users": () => ({ users: [] }),
  });
  render(
    <MemoryRouter initialEntries={[path]}>
      <ApiProvider client={api.client}>
        <SessionProvider>
          <SignInScreen go={go} />
        </SessionProvider>
      </ApiProvider>
    </MemoryRouter>,
  );
  return { api, go };
}

describe("sign-in page", () => {
  it("with WorkOS, goes straight to the API's sign-in and carries where to go back to", async () => {
    const { api, go } = renderAt("/sign-in?next=%2Fops%2Fclients", "workos");
    await waitFor(() =>
      expect(go).toHaveBeenCalledWith("/api/auth/sign-in?return_to=%2Fops%2Fclients"),
    );
    expect(go).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("signin-workos")).toBeNull();
    expect(screen.queryByTestId("signin-email-input")).toBeNull();
    expect(api.calls).not.toContain("GET /api/auth/dev/users");
  });

  it("never carries an off-site next", async () => {
    const { go } = renderAt("/sign-in?next=%2F%2Fevil.example", "workos");
    await waitFor(() => expect(go).toHaveBeenCalledWith("/api/auth/sign-in"));
  });

  it("stays to say why a sign-in failed, with a button to start again", async () => {
    const { go } = renderAt("/sign-in?next=%2Fops%2Fclients&error=not_invited", "workos");
    const link = await screen.findByTestId("signin-workos");
    expect(link.getAttribute("href")).toBe("/api/auth/sign-in?return_to=%2Fops%2Fclients");
    expect((await screen.findByTestId("signin-error")).textContent).toContain("not been invited");
    expect(go).not.toHaveBeenCalled();
  });

  it("shows the development sign-in with the dev adapter", async () => {
    const { go } = renderAt("/sign-in", "dev");
    expect(await screen.findByTestId("signin-email-input")).toBeTruthy();
    expect(go).not.toHaveBeenCalled();
    expect(screen.queryByTestId("signin-workos")).toBeNull();
  });

  it("turns error codes into words, with a fallback for unknown ones", () => {
    expect(signInErrorText(null)).toBeNull();
    expect(signInErrorText("email_not_verified")).toMatch(/Verify your email/);
    expect(signInErrorText("<script>")).toBe("Sign-in did not finish. Start again.");
  });
});
