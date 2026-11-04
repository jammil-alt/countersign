# Podio fixtures

Synthetic answers in the shapes of Podio's OAuth token endpoint and API (orgs with spaces, a space's
apps, an app with fields, items, filter, item create/update, comment, task, errors). Not recordings of a
live Podio account: shapes follow Podio's official PHP client (`podio/podio-php`) and the docs summaries
noted in `packages/connectors/src/podio/NOTES.md`; re-check against a real Podio org before launch.
Tests serve them through `fakePodio()` in `packages/connectors/src/testing.ts`; nothing calls Podio.
