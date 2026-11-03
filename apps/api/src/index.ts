// @countersign/api: the Hono Worker. Serves /api/*, the built apps/web as static assets, the
// Cloudflare Workflow classes and the cron handler. The only place that wires packages together.
import { routes } from "@countersign/core";
import { Hono } from "hono";

export const app = new Hono<{ Bindings: Env }>();

app.get(routes.health.path, (c) => c.json(routes.health.response.parse({ ok: true })));

export default {
  fetch: app.fetch,
  async scheduled() {
    // The senses sweep and schedule check arrive with packages/senses and packages/workflows.
  },
} satisfies ExportedHandler<Env>;
