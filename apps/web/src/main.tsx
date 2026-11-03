// @countersign/web: React + Vite app. Talks to apps/api over HTTP using the route contract in
// @countersign/core; screens follow the owner's Groundwork designs (docs/design/).
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
