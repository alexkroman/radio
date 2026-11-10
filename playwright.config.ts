import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test",
  timeout: 90_000,
  expect: { timeout: 60_000 },
  reporter: "list",
  use: {
    baseURL: process.env.BASE_URL ?? "https://localhost",
    ignoreHTTPSErrors: true,
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
  },
});
