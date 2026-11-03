// jest-dom matchers, and unmounting after each test so one test's DOM can't satisfy the next's queries.
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(cleanup);
