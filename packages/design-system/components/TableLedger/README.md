# TableLedger

Pattern A — the spreadsheet. For people who live in numbers: reconciling, auditing, exporting. Every cell is a value; nothing is decorated.

- **Density:** `row-h-dense` (28px) rows, 1px `line` gridlines on both axes, mono tabular figures throughout.
- **Structure:** a row-number gutter and the identity column (`Account`) are frozen left; the two-row header (column groups over columns) and the totals are frozen top and bottom while the body scrolls in both directions.
- **Column groups:** group related measures under one spanning head (Billing · Performance). Two levels at most.
- **Footer:** a `Σ` Total row and an `x̄` Average row, always visible. Ratios (avg ticket) are recomputed from totals, never averaged.
- **Column statistics:** clicking any cell selects its column (`slate-tint`) and the status bar reports count, sum, average, median, min and max — distinct and most-common for text columns.
- **Numbers:** accounting style — negatives in parentheses and `risk`, units in the value (`34d`), no colour fills.
- Consumer provides: columns (key, label, numeric, formatter, totalled), rows, and the filter string.
- Use when: the data will be checked, compared cell-by-cell, or exported. Don't use when the reader needs the shape of the data at a glance — use `TableAnalytical`.
