// @countersign/api: the Hono Worker. Serves /api/*, the built apps/web as static assets, the
// Cloudflare Workflow classes and the cron handler. The only place that wires packages together.
import { Hono } from "hono";

export const app = new Hono<{ Bindings: Env }>().basePath("/api");

app.get("/health", (c) => c.json({ ok: true }));

export default {
  fetch: app.fetch,
  async scheduled() {
    // The senses sweep and schedule check arrive with packages/senses and packages/workflows.
  },
} satisfies ExportedHandler<Env>;
