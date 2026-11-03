/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // `pnpm dev:web` runs beside `pnpm dev`, which serves the API on :8787.
  server: { proxy: { "/api": { target: "http://localhost:8787" } } },
  // apps/api serves this folder as its static assets (wrangler.jsonc `assets.directory`).
  build: { outDir: "dist", emptyOutDir: true },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});
