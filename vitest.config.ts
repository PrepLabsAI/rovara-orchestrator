import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["packages/*/src/**/*.test.ts", "packages/*/src/**/*.test.tsx"], testTimeout: 20_000 } },
      { test: { name: "infra", include: ["infra/test/**/*.test.ts"], testTimeout: 60_000 } },
      { test: { name: "contract", include: ["tests/contract/**/*.test.ts"] } },
      { test: { name: "integration", include: ["tests/integration/**/*.test.ts"], testTimeout: 30_000 } },
      { test: { name: "fault", include: ["tests/fault/**/*.test.ts"], testTimeout: 120_000 } },
      { test: { name: "e2e", include: ["tests/e2e/**/*.test.ts"], testTimeout: 3_600_000 } },
      { test: { name: "load", include: ["tests/load/**/*.test.ts"], testTimeout: 3_600_000 } },
    ],
  },
});
