// The ROMCO demo's entry (demo/romco.html, `pnpm --filter @countersign/web demo:build`): the
// app's own styles and theme, then the demo.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { loadCatalog } from "../../i18n/catalog";
import { applyStoredTheme } from "../../shell/theme";
import "../../styles.css";
import { DemoApp } from "./DemoApp";

applyStoredTheme();
const root = document.getElementById("root");
if (!root) throw new Error("demo/romco.html has no #root");
// The app's words are a chunk of their own (docs/plan.md §1.208); English first, then the demo.
void loadCatalog("en").then(() =>
  createRoot(root).render(
    <StrictMode>
      <DemoApp />
    </StrictMode>,
  ),
);
