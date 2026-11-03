# TableHeatmap

Pattern D — the matrix. Rows are entities, columns are periods, each cell is shaded by its value so patterns across time and accounts show before any number is read.

- **Two encodings, one control:** *Billed* uses the sequential ramp `data-seq-1…5` (one hue, light → dark, binned by quintile); *Change m/m* uses the diverging set `data-down` · `data-down-soft` · `data-mid` · `data-up-soft` · `data-up` with a neutral grey midpoint (±3%).
- **Every cell keeps its number** (`$24.3k`, `+6%`): colour is for scanning, the text is the value. Ink text on steps 1–3 and the soft steps; `paper` on steps 4–5 and the poles — all 4.5:1+.
- **2px surface gaps** between cells; no gridlines.
- **Margins:** a Total (or 6-month change) column and an "All accounts" footer row, both in plain text — never shaded, so they don't compete.
- **Crosshair hover:** the row and column heads highlight and a tooltip gives the exact value and the change vs the prior period.
- **Legend:** always present in the status bar with the bin edges, rewritten when the encoding changes.
- Consumer provides: entities × periods values, the binning (quantiles or fixed edges), the diverging threshold.
- Use when: comparing many entities over 4–12 periods (months, weeks, stages). Not for a single period — use `TableAnalytical`.
