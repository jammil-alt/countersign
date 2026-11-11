// jest-dom matchers, and unmounting after each test so one test's DOM can't satisfy the next's queries.
import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";
import { loadAllCatalogs } from "../i18n/catalog";

// findBy/waitFor give up after 1 s by default. The back office is a lazy chunk (App.tsx) whose first
// import in a test file transforms the whole /ops graph, and on a busy CI runner that alone can take
// longer, leaving a test looking at "Loading…". A wait ends as soon as its element appears, so a
// longer ceiling costs nothing when tests pass; it only stops load from failing them.
configure({ asyncUtilTimeout: 5000 });

afterEach(cleanup);

// The app loads one language, the session's (docs/audit-plan.md 4.1); tests read several side by
// side, so all six are loaded before any test runs. The lazy path has its own tests
// (i18n/lazy.test.tsx, session/session.test.tsx).
await loadAllCatalogs();
