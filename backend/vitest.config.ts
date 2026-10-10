import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: true,
    env: {
      NODE_ENV: "test",
      LLM_PROVIDER: "offline",
      SPEECH_PROVIDER: "offline",
      DOC_STORE: "local",
      EMAIL_TRANSPORT: "console",
      EMAIL_QUEUE: "none",
      PURGE_INTERVAL_MS: "0",
      DATABASE_FILE: ":memory:",
      LOG_LEVEL: "silent",
      PROVIDER_API_KEY: "test-provider-key",
    },
  },
});
