import { defineConfig } from "vitest/config";

// Unit tests only; recorded responses come from fixtures/llm (LLM_MODE=replay).
export default defineConfig({ test: { environment: "node", testTimeout: 30_000 } });
