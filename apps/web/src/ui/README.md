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
- `Loaded` — `state` (from `useApi`) and `children(data)`: a skeleton on the first load, the error with
  Try again, or the data. `skeleton` is the screen's own shapes (below); without one it shows a page
  body's (`SkeletonPage`). Never loading text after the frame is up.
  Empty lists use `EmptyState` (`primitives.tsx`): an optional `title`, the line (`line` or
  `children`) and an optional `action` (`{ label, to }` for a link, `{ label, onClick }` for a button).

## Skeletons (`skeleton.tsx`)

Placeholders the size of the content, so nothing moves when it arrives. The shapes are
`aria-hidden`; `Skeleton` around them is the one `role="status"`, with a visually hidden "Loading…" (or
its `label`) for screen readers. A slow fade, none under reduced motion. Tokens only (`ui-skel*` in
`page.css`).

- `Skeleton` — the status wrapper: `label`, the shapes as children. `Loaded` adds it for you.
- `SkeletonLine` — one line of text: `width` (`full`, `long`, `half`, `short` or pixels), `size`
  (`small`, `text`, `heading`, `title`), each the line's own height.
- `SkeletonText` — `lines` lines, the last shorter. `SkeletonBlock` — a shape `height` tall.
- `SkeletonCard` — a padded `Card`: a title line and `lines` of text. `SkeletonStat` — a `StatTile`;
  `SkeletonStats` — a `KpiStrip` of `count`.
- `SkeletonRows` — a table in a card: `rows` rows of `columns` cells at `--row-h`.
- `SkeletonPage` — a heading line and `cards` cards: `Loaded`'s default.
- `Loading` (`primitives.tsx`) — the same, for a hand-written loading state: three lines by default,
  `size="line"` for a small slot; its `label` is read, not shown.

## Cards and figures

- `Card` (`primitives.tsx`) — `title`, `meta` (right side of the head), `footer`, `pad` (padded body),
  `dashed`. Without a title it is a plain sheet, as before.
- `StatTile` (`figures.tsx`) — `label`, `value`, `note`, `noteTone` (`risk`, `signal`, `positive`), `alert`
  (risk border and figure, for "Need us"), `tone` (an `AccentTone`: the state colour's accent on
  top; `signal` also tints the tile, for "Waiting on you"), `mark` (a `Sparkline` or `Delta` beside
  the value), `to` (the tile is a link to its list).
- `KpiStrip` — a row of `StatTile`s, as many as fit, two at phone width. Four at most; leave out a
  tile with nothing to say rather than show a 0 (runs always show).
- `ProgressBar` — `value`, `max`, `label` (for screen readers), `tone` (`accent`, `waiting`, `risk`).
- `Sparkbars` — `values` (`{ value, failed? }[]`), `label`. Failed bars in risk.
- `Sparkline` — `days` (`{ runs, failed? }[]`, oldest first: the API's `perDay`, `KPI_DAYS` long),
  `label` (it in words). The design system's `dt-spark`: a `data-line` line, a dot on today, a risk
  dot on a day with a failed run. `hasRuns(days)` says whether there is anything to draw.
- `Delta` — `now`, `before`, `words(direction, by)`: the change from last time with `dt-delta`'s
  arrow in `data-up` / `data-down`, always in words.

## State colour and accents (`page.css`)

`ui-accent` (a 3px bar on the top) or `ui-accent ui-accent--left` (on the left), with `data-tone`
`signal`, `positive`, `risk`, `slate` or `copper`: a mark, not a border colour or a shadow, and
always beside a chip or word that says the state. Used on agent cards (Home, the client page's
agent rows), Needs us and Escalations rows, Inbox entries (`entryTone`) and Inbox cards (the status
badge's colour). `ui-kpiline` is a slim line of figures under a title (the client page's header).

## People and agents (`badges.tsx`)

- `AgentBadge` — `name`, `seed` (the agent's id), `size` (`sm` 28, `md` 36, `lg` 52): the initials
  tile in the agent's own colour: a solid block of slate, copper, green (`positive`), mustard
  (`signal-ink`) or steel (`data-seq-4`), with `surface` initials, as on the owner's v1 screens.
  `agentHue(seed)` picks it from the id; `AgentHuesProvider` (given a client's agents) spreads them
  so a client's first five never share one. Pass the id wherever you have it.
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

## Long descriptions (`brief.ts`, `sheet.tsx`)

A list shows a title and one plain line; the whole text opens in a `SideSheet` from the row or card
("In full", a `SheetSection`). `brief(text)` makes the line: the first sentence, without asides in
brackets, field names in backticks or the list after a colon, cut at 120 characters with "…".
`saysMore(full, line)` says whether the sheet needs the "In full" section. Tools read by the
written titles and lines in `../ops/library/plain.ts` (`toolName`, `toolLine`, `connectorLine`).

## The frame (`../shell`)

`AppShell` (top bar, sidebar, page; `topAction` beside the Inbox: the portal's Ask Sloan;
`switcher` handed to the agent page's header), `SidebarLink`, `SidebarSection`, `SidebarMore`,
`SidebarAgent`, `SearchBox` (⌘K), `AgentSwitcher` (`canSwitch`), `HeaderSwitcher` (where an agent
page's header draws the switcher, after its eyebrow, like a breadcrumb; `PageHeader`'s `beside`),
`Redirect`. Routes: `../portal/routes.tsx` and `../ops/routes.tsx`
(one line per route); page addresses: `../portal/paths.ts` and `../ops/paths.ts`.
