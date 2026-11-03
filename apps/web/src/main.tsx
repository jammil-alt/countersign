// @countersign/web: the Mezonas app (React + Vite). Talks to apps/api over HTTP using the route
// contract in @countersign/core; screens follow the owner's v1 layouts (docs/design/) on the Mezonas
// design system (packages/design-system).
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
