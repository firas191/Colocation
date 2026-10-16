import { defineConfig, devices } from "@playwright/test";

// The website against the running stack (docker compose on the PC, or the cloud sandbox).
//   E2E_BASE_URL    the website (default http://localhost:3000)
//   E2E_MAIL_API    Mailpit's HTTP API (default http://localhost:8025)
//   E2E_API_BASE    the platform API (proxy), for the upload test (default http://localhost:8080)
//   FS_SECRETS_FILE secrets/api-clients.env (the "tests" key), for the upload test
//   PW_CHROMIUM     path of a Chromium binary when Playwright's own download is not available
//   PW_HOST_RULES   Chromium host mapping, for running inside docker: "MAP localhost proxy" keeps the pages on
//                   http://localhost:3000 (the origin the stack expects) while reaching the proxy container
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://localhost:3000",
    trace: "retain-on-failure",
    launchOptions: {
      ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}),
      ...(process.env.PW_HOST_RULES ? { args: [`--host-resolver-rules=${process.env.PW_HOST_RULES}`] } : {}),
    },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "phone", use: { ...devices["Pixel 7"], viewport: { width: 360, height: 780 } } },
  ],
});
