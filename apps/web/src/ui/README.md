# Shared page parts

What every screen is built from, on the Mezonas design system (`packages/design-system`). Styles are in
`page.css` (and the frame's in `../shell/shell.css`), tokens only. Use these before writing new classes;
where a part doesn't fit, add a prop here rather than a one-off in a screen.

## Colour meanings

| Meaning | Colour | Where |
|---|---|---|
| Brand, actions, selection, running | slate | primary buttons, the current nav item, `StatusChip state="running"`, `ProgressBar` |
| People: the lead, sign-offs, person steps | copper | `PersonBadge`, `StatusChip state="person"`, `StepList` person steps |
| Waiting on you | signal (gold), always with a word | `StatusChip state="waiting"`, counts (`Count tone="warning"`), `ProgressBar tone="waiting"` |
| Errors, blocked, failed | risk | `StatusChip state="blocked"\|"failed"`, `StatTile alert`, `ErrorNotice` |
| Done, checked | positive | `StatusChip state="done"\|"checked"`, done steps |
| Setting up, idle, paused | neutral | `StatusChip state="setup"\|"idle"\|"paused"` |

Agents' work stays ink. Borders, not shadows. No raw colours.

`StatusChip`'s mapping is fixed in `CHIP_TONE` (`status.tsx`); `runChipState` and `serviceChipState`
turn API statuses into chip states (the back office). The chip's words are always the caller's, in the
reader's language.

In the client portal every run and agent goes through the one status model in
`../portal/status.ts`: `runChip` (Running, Waiting on you, Done, Failed, Stopped; a run that waits on
the client is never Running, whatever its stored status) and `agentChip` (Working, Waiting on you,
Ready, Paused, Setting up). `workedMs` is a run's "Took": its time less the time it waited on you.

In the back office every run goes through `runChip(run)` in `../ops/run/words.ts` (pass the run, with
its `waiting`, not its status): a run waiting on a person reads "Waiting for approval · client admin"
(or a named person, or "us"), never Running. `waitLine` adds how long, `NOBODY_TO_ACT_WORDS` why
nobody can approve, and `runErrorLine` a failed run's reason at its step's name. Both surfaces derive
the state from core's `runState` (`packages/core/src/api/run-state.ts`).

## Layout (`page.tsx`)

- `Page` — a page's column (1200px, sections 32px apart); `width="narrow"` for forms.
- `PageHeader` (`primitives.tsx`) — `eyebrow`, `title`, `subtitle`, `actions`, plus `leading` (an
  `AgentBadge size="lg"`) and `badge` (a chip beside the title).
- `Section` — `title` (heading), `meta` (muted text on the right), `action`.
- `PageGrid` — the main column and a 340px right rail (`rail`); the rail drops below on narrow screens.
- `Columns` — `count` 2, 3 or 4 even columns; one column at phone width.
- `Loaded` — `state` (from `useApi`) and `children(data)`: Loading, the error with Try again, or the data.
  Empty lists use `EmptyState` (`primitives.tsx`): an optional `title`, the line (`line` or
  `children`) and an optional `action` (`{ label, to }` for a link, `{ label, onClick }` for a button).

## Cards and figures

- `Card` (`primitives.tsx`) — `title`, `meta` (right side of the head), `footer`, `pad` (padded body),
  `dashed`. Without a title it is a plain sheet, as before.
- `StatTile` (`figures.tsx`) — `label`, `value`, `note`, `noteTone` (`risk`, `signal`, `positive`), `alert`
  (risk border and figure, for "Need us").
- `ProgressBar` — `value`, `max`, `label` (for screen readers), `tone` (`accent`, `waiting`, `risk`).
- `Sparkbars` — `values` (`{ value, failed? }[]`), `label`. Failed bars in risk.

## People and agents (`badges.tsx`)

- `AgentBadge` — `name`, `size` (`sm` 28, `md` 36, `lg` 52): the initials tile.
- `PersonBadge` — `name`, `line` (shows name and line beside the badge), `plain` (a client's own person,
  not copper), `size`.

## Steps and activity

- `StepList` (`steps.tsx`) — `steps`: `{ key, title, detail?, state, time?, children?, testId? }[]`, `state` one of
  `done`, `current`, `waiting`, `failed`, `person`, `todo`. A time column appears when any step has `time`.
  Each mark says its state in words for screen readers.
- `ActivityRow` (`activity.tsx`) — `time`, `badge`, `children` (the text), `end` (a chip or receipt),
  `to` (links the text). Rows inside a `Card` are divided by hairlines.
- `BeforeAfter` — `before`, `after`, `beforeLabel`, `afterLabel` ("After you sign"). Stacked on phones.

## Also in `primitives.tsx`

`Badge`, `Tag`, `Count`, `Button`/`buttonClass`, `Tabs`, `SubTabs` (a tab's own pages as the Segmented,
each a route: the client page's Data and Setup), `SectionLabel`, `AgentAvatar`, `Loading`,
`ErrorNotice`, `EmptyState`, `Placeholder`. Forms are in `forms.tsx`, icons in `icons.tsx`.

## The frame (`../shell`)

`AppShell` (top bar, sidebar, page), `SidebarLink`, `SidebarSection`, `SidebarMore`, `SidebarAgent`,
`SearchBox` (⌘K), `AgentSwitcher`, `Redirect`. Routes: `../portal/routes.tsx` and `../ops/routes.tsx`
(one line per route); page addresses: `../portal/paths.ts` and `../ops/paths.ts`.
