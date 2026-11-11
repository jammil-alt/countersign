/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * Preloads the two Geist fonts from index.html (docs/audit-plan.md 4.5), so text does not wait for
 * the stylesheet to be parsed before its fonts are asked for. The design system's files stay as
 * delivered: this links the hashed files the build emits for tokens.css's @font-face, by name.
 */
// DECISION: Geist and Geist Mono both (the brand's two faces; numbers and eyebrows are mono on
// most screens). A build without either fails, so a renamed font file cannot drop it quietly.
function preloadFonts(): Plugin {
  const FONTS = [
    /^assets\/Geist-Variable-[\w-]+\.woff2$/,
    /^assets\/GeistMono-Variable-[\w-]+\.woff2$/,
  ];
  return {
    name: "mezonas-preload-fonts",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(_html, ctx) {
        const files = Object.keys(ctx.bundle ?? {});
        return FONTS.map((font) => {
          const file = files.find((f) => font.test(f));
          if (!file) throw new Error(`preloadFonts: no emitted file matches ${font}`);
          return {
            tag: "link",
            attrs: {
              rel: "preload",
              href: `/${file}`,
              as: "font",
              type: "font/woff2",
              crossorigin: "",
            },
            injectTo: "head" as const,
          };
        });
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), preloadFonts()],
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
