# TableAnalytical

Pattern B — the analytical table. Each row shows its shape, not just its value: magnitude as an in-cell bar, change as a signed delta, history as a sparkline, progress against a target as a bullet.

- **Column profiles:** under every measure head sits a profile — an 8-bin histogram of that column with a one-line summary (Σ, up/down split, at-target count, median). Hover a bin for its range and count. The trend column's profile is the aggregate sparkline of all rows.
- **In-cell bar:** `data-bar` on a `data-track`, scaled to the column max, value printed to the right in mono. Bars are magnitude only, never clickable.
- **Delta:** `▲`/`▼` glyph in `data-up` / `data-down` plus a signed percentage in `ink`. Direction is never colour alone.
- **Sparkline:** 12 points, 1.5px `data-line`, end dot with a 2px surface ring. Hover shows a crosshair and a tooltip with the week, value and week-on-week change.
- **Bullet:** collected share as a `data-line` bar with a 2px `ink` target tick at 90%.
- **Thresholds:** a value past its threshold gets a `StatusPill` word ("Late") beside the number, not a red cell.
- Text is always in text tokens; only marks wear data colours.
- 48px rows (two-line identity cell). Sort on every numeric column.
- Consumer provides: rows with current, prior and a series per row; the target; thresholds.
- Use when: someone needs to spot outliers and direction in a list of under ~50 entities. Not for exports or cell-level checking — use `TableLedger`.
