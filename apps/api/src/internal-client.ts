// One of our own clients: `tenant.settings.internal` (M43, docs/plan.md §1.72), Mezonas as its own
// first client, served like any other. Its data is real (never purged like a demo), it is never
// billed (no Stripe customer is set up for it, so the billing pass never reaches it), and it gets
// no Weekly Table. An operator sets it from the client's settings, logged in `tenant_change`.

export const INTERNAL_SETTING = "internal";

export function isInternal(settings: Record<string, unknown>): boolean {
  return settings[INTERNAL_SETTING] === true;
}
