# Golden invoices

Synthetic millwork invoices (docs/plan.md §1.2 "Invoices for fixtures"), made by `generate.mjs`
from one source so what is printed and what is expected can't drift:

| File | Vendor | What it tests |
|---|---|---|
| `northline-20418.pdf` | Northline Panel Supply | Sheet goods; one page; no freight or tax |
| `cedar-ridge-7731.png` | Cedar Ridge Hardwoods | Hardwood by the board foot; an image, not a PDF; freight plus a fuel surcharge |
| `keystone-55102.pdf` | Keystone Hardware & Finishes | Hardware and finishes; 32 lines over two pages; freight and sales tax; unit prices to 4 places |

`*.expected.json` is the `InvoiceExtraction` (packages/core) each should extract to. The model's
answers for them in `fixtures/llm/` are hand-written for now; see `fixtures/llm/README.md`.

Regenerating (`node fixtures/invoices/generate.mjs`) changes the files' bytes and so the request
hashes: rebuild or re-record the LLM fixtures afterwards.
