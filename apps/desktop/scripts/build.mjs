#!/usr/bin/env node
// Builds the desktop app: the renderer with Vite, then the main process and the preload with
// esbuild into CommonJS (Electron loads both as files from the app's package). Everything is
// bundled, so the packaged app carries dist/ and nothing from node_modules.
import { build as esbuild } from "esbuild";
import { build as vite } from "vite";

const root = new URL("..", import.meta.url).pathname;

await vite({ configFile: `${root}vite.config.ts`, logLevel: "warn" });

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: true,
  external: ["electron"],
  logLevel: "warning",
  define: {
    "process.env.MEZONAS_BUILD_API_URL": JSON.stringify(process.env.MEZONAS_API_URL ?? ""),
  },
};
await esbuild({
  ...common,
  entryPoints: [`${root}src/main/index.ts`],
  outfile: `${root}dist/main/index.cjs`,
});
await esbuild({
  ...common,
  entryPoints: [`${root}src/preload/index.ts`],
  outfile: `${root}dist/preload/index.cjs`,
});
