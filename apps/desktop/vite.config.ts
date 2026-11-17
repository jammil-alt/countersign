// The renderer: a React page loaded from the app's own files (never a remote page), with the
// design system's tokens, components and fonts bundled in.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
    // Electron's Chromium: no older browsers to support.
    target: "chrome140",
  },
});
