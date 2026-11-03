# Countersign

A multi-tenant back-office agent platform. It connects to a small business's systems (QuickBooks Online
first, plus manual upload), keeps a clean copy of their data, and runs named, versioned agents that each
own one back-office job. The first job is material cost management: pull purchases, find and extract
the invoice, match each line to a shared item catalog across vendors, track unit prices and alert when
they change.

- Architecture (what): [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Implementation plan (how, in what order): [`docs/plan.md`](docs/plan.md)
- Working rules: [`CLAUDE.md`](CLAUDE.md)

Status: skeleton and plan. M0 (app, DB, Inngest, auth) is next.

```sh
pnpm install
cp .env.example .env
pnpm db:up
```
