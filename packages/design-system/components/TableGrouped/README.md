# TableGrouped

Pattern C — grouped with subtotals. Answers "where is the money" before "which account": one row per segment, expandable to its accounts.

- **Group rows:** `surface-subtle`, 40px, semibold, a chevron toggle and a `dt-count` of members. Click anywhere on the row to expand. Groups sort by their subtotal, largest first.
- **Child rows:** 36px, indented 44px, sorted by value inside the group.
- **Subtotals are recomputed, not summed blindly:** collection rate is collected ÷ billed for the group; days-to-pay is billed-weighted.
- **Share of total:** one bar scale for groups and children alike (scaled to the largest group) so a child's bar reads against its parent's; groups in `data-line`, children in `data-bar`; the percentage of grand total beside it.
- **Grand total:** footer row under a 2px `ink` rule, naming how many groups and rows it covers.
- **Group by:** a `Segmented` control switches the grouping dimension; switching collapses everything.
- One level of grouping in this pattern; deeper hierarchies become a tree table with the same row styles.
- Consumer provides: rows, the grouping keys offered, and which aggregate each column uses (sum, ratio, weighted average).
- Use when: the reader thinks in segments (trade, region, rep) and drills down. Not for flat lists under ~15 rows.
