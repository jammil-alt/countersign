# WorksheetRow

One step in a Worksheet: number, what was done, who did it, and its Receipt.

- Consumer provides: `div.mz-ws` with `mz-ws__n` (two-digit step), the step in plain words, `mz-ws__who` (a team role, or `--lead` in copper for the lead's check) and a `ReceiptChip` or a `StatusPill`.
- The last step of every worksheet is the lead's check.
