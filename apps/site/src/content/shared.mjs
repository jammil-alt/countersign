// @ts-check
// Shared pieces of the site's content: the line icons the diagrams draw and who does each step.
// Edit the copy in what.mjs, hire.mjs and security.mjs; the components only lay it out.

/**
 * Line icons on a 24px grid, 1.5px stroke, square caps (brand book, Iconography), as the path
 * data the components draw. From the site design (mezonas-site-handoff, 2026-11).
 */
export const ICONS = {
  db: "M5 6c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3zM5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3",
  search: "M11 5a6 6 0 1 0 0 12 6 6 0 1 0 0-12zM16 16l4 4",
  people:
    "M9 5a3 3 0 1 0 0 6 3 3 0 1 0 0-6zM3 20c0-3.5 2.7-6 6-6s6 2.5 6 6M17 6.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 1 0 0-5zM15 14.5c3 0 6 2 6 5.5",
  chat: "M4 5h16v11H9l-5 4z",
  check: "M5 12l5 5 9-10",
  pen: "M4 20l4-1 11-11-3-3L5 16zM14 7l3 3",
  doc: "M5 3h14v18H5zM8 8h8M8 12h8M8 16h5",
  link: "M9 7H6a4 4 0 0 0 0 8h3M15 7h3a4 4 0 0 1 0 8h-3M8 11h8",
  chart: "M5 20V10M12 20V4M19 20v-7",
  mail: "M3 5h18v14H3zM3 7l9 6 9-6",
  target: "M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18zM12 8a4 4 0 1 0 0 8 4 4 0 1 0 0-8z",
  loop: "M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5",
  shield: "M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z",
  card: "M3 6h18v12H3zM3 10h18M7 15h4",
  folder: "M3 6h7l2 2h9v11H3z",
  mega: "M4 10v4h3l6 4V6L7 10zM17 9a4 4 0 0 1 0 6",
  phone:
    "M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z",
  web: "M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18",
  lock: "M5 10h14v10H5zM8 10V7a4 4 0 0 1 8 0v3",
  person: "M12 4a3.5 3.5 0 1 0 0 7 3.5 3.5 0 1 0 0-7zM5 20c0-3.9 3.1-6.5 7-6.5s7 2.6 7 6.5",
  chip: "M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4",
  plus: "M12 5v14M5 12h14",
};

/** @typedef {keyof typeof ICONS} Icon */

/**
 * Who does a step, and the colour that says so (brand book: slate for agents' tools, copper for
 * people, gold tint for you, grey for your systems). `tone` is a class suffix in site.css.
 */
export const ACTORS = {
  system: { tone: "system", label: "Systems" },
  agent: { tone: "agent", label: "Agent" },
  team: { tone: "person", label: "Your team" },
  person: { tone: "person", label: "Your lead" },
  you: { tone: "you", label: "You" },
};

/** @typedef {keyof typeof ACTORS} Actor */

/**
 * One step of a workflow: its icon, who does it, the verb, what happens and a detail.
 * @typedef {[Icon, Actor, string, string, string]} Step
 */
