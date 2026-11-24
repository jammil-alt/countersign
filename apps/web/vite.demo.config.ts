// The click-through demos (demo/*.html, src/demo/): built into one self-contained HTML file each,
// to share as a file or a page. Everything (scripts, styles, fonts, icons) is inlined, so the
// file opens anywhere with no server and calls nothing. Not part of the app's build or deploy.
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** Puts the built script and stylesheet inside the page, so the page is the only file. */
function oneFile(): Plugin {
  return {
    name: "mezonas-demo-one-file",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      for (const page of Object.values(bundle)) {
        if (page.type !== "asset" || !page.fileName.endsWith(".html")) continue;
        let html = String(page.source);
        for (const [name, file] of Object.entries(bundle)) {
          const ref = new RegExp(
            `<script type="module" crossorigin src="[^"]*${literal(name)}"></script>`,
          );
          if (file.type === "chunk" && ref.test(html)) {
            // With every chunk inlined there is nothing to preload: Vite leaves the list's placeholder.
            const code = file.code
              .replace(/__VITE_PRELOAD__/g, "void 0")
              .replace(/<\/script/gi, "<\\/script");
            html = html.replace(ref, () => `<script type="module">${code}</script>`);
            delete bundle[name];
          }
          const css = new RegExp(
            `<link rel="stylesheet" crossorigin href="[^"]*${literal(name)}">`,
          );
          if (file.type === "asset" && name.endsWith(".css") && css.test(html)) {
            html = html.replace(css, () => `<style>${String(file.source)}</style>`);
            delete bundle[name];
          }
        }
        // Files the app refers to by address (connector logos, the favicon) become data URIs.
        for (const [name, file] of Object.entries(bundle)) {
          if (file.type !== "asset" || name.endsWith(".html")) continue;
          const type = MIME[name.slice(name.lastIndexOf(".") + 1)];
          if (!type || !html.includes(`/${name}`)) continue;
          const data = `data:${type};base64,${Buffer.from(file.source).toString("base64")}`;
          html = html.split(`/${name}`).join(data);
          delete bundle[name];
        }
        page.source = html;
      }
    },
  };
}

const MIME: Record<string, string> = {
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  woff2: "font/woff2",
};

const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export default defineConfig({
  plugins: [react(), tailwindcss(), oneFile()],
  build: {
    outDir: "dist-demo",
    emptyOutDir: true,
    assetsInlineLimit: () => true,
    cssCodeSplit: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: { romco: "demo/romco.html" },
      output: { inlineDynamicImports: true },
    },
  },
});
