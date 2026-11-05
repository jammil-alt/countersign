/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // `pnpm dev:web` runs beside `pnpm dev`, which serves the API on :8787.
  server: { proxy: { "/api": { target: "http://localhost:8787" } } },
  // apps/api serves this folder as its static assets (wrangler.jsonc `assets.directory`).
  // Source maps only for error tracking: the deploy uploads them to Sentry, then deletes them so
  // they are never served (`hidden`: the bundles don't point at them).
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: process.env.SENTRY_SOURCEMAPS === "1" ? "hidden" : false,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    // Screen tests render whole routes, lazy chunks included, and type into forms key by key. Alone
    // they take a second or two; with every package's tests running at once on a CI runner, a few
    // pass Vitest's 5 s default (WorkflowBuilder, Onboarding, App). 20 s still catches a hang.
    testTimeout: 20_000,
  },
});
