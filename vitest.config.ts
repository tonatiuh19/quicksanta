import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

const alias = {
  "@": path.resolve(import.meta.dirname, "client"),
  "@shared": path.resolve(import.meta.dirname, "shared"),
};

/**
 * Three projects (pick with --project):
 * - unit:        pure helpers + every API route against the in-memory fake DB (api/testFakeDb.ts). No network. Seconds.
 * - ui:          React component/page specs in jsdom (store + api mocked).
 * - integration: supertest against the real shared TiDB (*.integration.test.ts). Slow; run with `npm run test:integration`
 *                or `npm run deploy:prod -- --full`.
 * `npm test` = unit + ui (what deploy:prod runs by default).
 */
export default defineConfig({
  plugins: [react()],
  resolve: { alias },
  test: {
    env: { VITEST: "true" },
    projects: [
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: "unit",
          include: ["api/**/*.test.ts", "client/**/*.spec.ts", "shared/**/*.test.ts"],
          exclude: ["**/*.integration.test.ts", "node_modules/**"],
          environment: "node",
          env: { VITEST: "true", QS_FAKE_DB: "1" },
          sequence: { groupOrder: 0 },
        },
      },
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: "ui",
          include: ["client/**/*.spec.tsx"],
          environment: "jsdom",
          setupFiles: ["client/test/setup.ts"],
          env: { VITEST: "true" },
          sequence: { groupOrder: 1 },
        },
      },
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: "integration",
          include: ["api/**/*.integration.test.ts"],
          globalSetup: ["api/testGlobalSetup.ts"],
          environment: "node",
          env: { VITEST: "true" },
          testTimeout: 120_000,
          hookTimeout: 90_000,
          maxWorkers: 2,
          sequence: { groupOrder: 2 },
        },
      },
    ],
  },
});
