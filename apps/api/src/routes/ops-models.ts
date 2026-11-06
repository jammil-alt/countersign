// v0.13 W2-H: the models a task skill or a skill step may name, for the builder and the skills
// library (ARCHITECTURE §10.11, docs/plan.md §1.53). Platform data, the same for every client.

import { routes } from "@countersign/core";
import { knownModels } from "@countersign/llm";
import type { Hono } from "hono";
import { type AppEnv, mount } from "../http";

export function opsModelRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsModels, async () => ({ models: knownModels() }));
}
