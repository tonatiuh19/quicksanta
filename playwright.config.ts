import { defineConfig, devices } from "@playwright/test";

/**
 * Browser E2E against the running dev server (npm run dev) + Stripe TEST mode.
 * Run the dev server with RESEND_API_KEY= (email dry-run) and `stripe listen` forwarding webhooks.
 *   npm run e2e:browser
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  outputDir: process.env.E2E_OUT || "test-results",
  use: {
    baseURL: process.env.E2E_BASE_URL || "https://localhost:8080",
    ignoreHTTPSErrors: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 860 } }, testIgnore: /mobile\.spec\.ts/ },
    { name: "mobile", use: { ...devices["iPhone 13"], browserName: "chromium" }, testMatch: /mobile\.spec\.ts/ },
  ],
});
