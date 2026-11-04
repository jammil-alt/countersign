# Zoho CRM fixtures

Synthetic answers in the shapes of Zoho's OAuth and CRM API v8 responses (token, org, search, get,
create, update, note, task, errors). They are not recordings of a live Zoho account: shapes follow
Zoho's published docs as noted in `packages/connectors/src/zoho_crm/NOTES.md`; re-check them against
a sandbox org before launch. Tests serve them through a fake `fetch` (`fake-zoho.ts` in the
connector's tests); nothing calls Zoho.
