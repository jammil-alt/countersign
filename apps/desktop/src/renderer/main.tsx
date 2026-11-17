// The desktop app's window (docs/plan.md §1.124): React, the design system's CSS, and the
// bridge to the main process. It holds no secrets and reaches nothing but `window.mezonas`.
import sprite from "@countersign/design-system/assets/Icons/mezonas-icons-sprite.svg?raw";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// The icon sprite, once, so <use href="#mz-…"> finds its symbols. A file of ours, not data.
document.body.insertAdjacentHTML("afterbegin", sprite);

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
