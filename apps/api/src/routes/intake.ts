// The intake (docs/plan.md §1.125; docs/cases-plan.md §4.5): the back office reads a client's
// intakes (the build's Requirements panel reads its card from them); the client's people read and
// answer theirs on Getting started, each only the sections they were asked (all of them for the
// admin). Answers are data (invariant 9), checked against their field's kind (core
// `fieldValueSchema`); secrets are never asked and pasted ones are redacted before storage. The
// portal's views carry no `ours` fact, no fact id and nothing of ours (invariant 11).
//
// Stream INTAKE builds the handlers; until then each answers 501 `not_built`.

import { routes } from "@countersign/core";
import type { Hono } from "hono";
import { type AppEnv, mount } from "../http";
import { notBuilt } from "../onboarding/not-built";

export function intakeRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsIntakes, async () => {
    throw notBuilt("INTAKE", "opsIntakes");
  });
  mount(app, routes.opsIntake, async () => {
    throw notBuilt("INTAKE", "opsIntake");
  });
  mount(app, routes.portalCurrentIntake, async () => {
    throw notBuilt("INTAKE", "portalCurrentIntake");
  });
  mount(app, routes.portalIntake, async () => {
    throw notBuilt("INTAKE", "portalIntake");
  });
  mount(app, routes.portalIntakeAnswer, async () => {
    throw notBuilt("INTAKE", "portalIntakeAnswer");
  });
  mount(app, routes.portalIntakeConfirm, async () => {
    throw notBuilt("INTAKE", "portalIntakeConfirm");
  });
  mount(app, routes.portalIntakeAsk, async () => {
    throw notBuilt("INTAKE", "portalIntakeAsk");
  });
  mount(app, routes.portalIntakeDifferentProcess, async () => {
    throw notBuilt("INTAKE", "portalIntakeDifferentProcess");
  });
}
