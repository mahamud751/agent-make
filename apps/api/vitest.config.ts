import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/globalSetup.ts"],
    setupFiles: ["./test/setupEnv.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
