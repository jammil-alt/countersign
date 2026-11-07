// The agent switcher's place (UI cleanup, design pass): the frame knows the client's agents and
// which agent's page this is, and hands the switcher down; the agent page's header draws it after
// its eyebrow, like a breadcrumb ("HOME › Records clerk ▾"), instead of a bar of its own above the
// page. The frame hands one down only when there is another agent to switch to.
import { createContext, type ReactNode, useContext } from "react";

const HeaderSwitcherContext = createContext<ReactNode>(null);

export function HeaderSwitcherProvider({
  switcher,
  children,
}: {
  switcher: ReactNode;
  children: ReactNode;
}) {
  return (
    <HeaderSwitcherContext.Provider value={switcher}>{children}</HeaderSwitcherContext.Provider>
  );
}

/** "› [the switcher]": the switcher the frame handed down, or nothing. */
export function HeaderSwitcher() {
  const switcher = useContext(HeaderSwitcherContext);
  if (!switcher) return null;
  return (
    <>
      <span aria-hidden className="ui-crumbs__sep">
        ›
      </span>
      {switcher}
    </>
  );
}
