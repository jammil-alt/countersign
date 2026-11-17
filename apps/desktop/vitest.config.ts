// The main process's pure parts (folders, workbooks, jobs, sign-in, signed requests) run under
// Node; nothing here starts Electron.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
