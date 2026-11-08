# Materials pack: notes

## Prices from QuickBooks bills (`materials.backfill-from-bills`, P-5)

Written 2026-11-08. The tool reads what the QuickBooks sync already stored: each bill's latest
raw record (`raw_record`, entity `Bill`, the QBO payload as sent) through the transaction mapped
from it (`transaction.source_raw_record_id`, connector `qbo`, kind `bill`). Nothing is called live.
Like the connector's own notes (`packages/connectors/src/qbo/NOTES.md`), the bill shape comes from
what we knew of the QBO v3 API and the connector's fake.

What it uses:

| Bill part | Used for |
|---|---|
| `Line[]` with `DetailType: ItemBasedExpenseLineDetail` | One price each: `Qty`, `UnitPrice`, and the line's `Description` (else the item's name, `ItemRef.name`) for matching |
| `Line[].Id` | The line's key across the bill's versions, so a re-run or an edited bill adds nothing twice (its position when QBO gives no id) |
| `TxnDate` | The price's date |
| `CurrencyRef.value` | The price's currency (USD when absent) |
| The transaction's vendor | The vendor the price is for, and the vendor's aliases for matching |

What it can't use, and leaves:

- **Account lines** (`AccountBasedExpenseLineDetail`): an amount on an expense account, with no
  item, quantity or unit price. A bill entered as one "Materials" line has no price to record.
  They are counted (`accountLines`) and left. Itemized bills (one line per item) are what gives
  prices; the invoice workflow's itemizing step makes them.
- **Units.** QBO bill lines carry no unit of measure. The price is taken to be per the catalog
  item's standard unit (a sheet, a board foot, each, ...), as a document line without a unit is,
  and marked `uomAssumed` on the observation. A bill that prices oak per thousand board feet, or
  hardware per box, records a wrong unit price for that line: check the shop's bills before
  backfilling a long range.
- **Item lines without a quantity or unit price** (QBO allows an item line with only an amount):
  skipped and counted.
- **Lines the rules aren't sure of** (an item name like "Misc" or "Shop supplies", a description
  missing a key attribute): counted (`needsReview`) and listed with their candidates, at most 50 a
  call, never guessed. Nothing stores a decision for them: once the catalog has the item (from an
  invoice's match review, or `materials.catalog.create_item`), a later run matches the line.
- **QBO items themselves** (`Item` raw records: `Sku`, `PurchaseDesc`, `PurchaseCost`) are not read.
  A QBO item is the client's own name for a thing, not the vendor's, so it isn't an alias.
- **Vendor credits and card purchases** (`VendorCredit`, `Purchase`) are not read: bills only.
- **Deleted bills** (their `deleted` raw record version) are skipped; prices already recorded from
  them stay, like any price history.

To verify against a real QuickBooks company, once connected: how the shop enters material bills
(itemized or one account line), whether item lines carry descriptions, and whether quantities are
in the same unit the catalog uses.
