// The back office's client picker in tests: open it, pick a client by id ("" for All clients).
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

type User = ReturnType<typeof userEvent.setup>;

/** The names the picker offers, "All clients" first; leaves it closed. */
export async function clientOptions(user: User = userEvent.setup()): Promise<string[]> {
  await user.click(await screen.findByTestId("ops-client-switcher"));
  const menu = await screen.findByTestId("ops-client-switcher-menu");
  const names = within(menu)
    .getAllByRole("option")
    .map((o) => o.textContent ?? "");
  await user.keyboard("{Escape}");
  return names;
}

/** Picks the client with this id ("" for All clients). */
export async function pickClient(id: string, user: User = userEvent.setup()): Promise<void> {
  await user.click(await screen.findByTestId("ops-client-switcher"));
  await user.click(await screen.findByTestId(`ops-client-switcher-option-${id || "all"}`));
}
