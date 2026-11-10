import { defineConfig } from "@playwright/test";
import { STATE } from "./test/global-setup.ts";

export default defineConfig({
  testDir: "test",
  timeout: 90_000,
  expect: { timeout: 60_000 },
  reporter: "list",
  globalSetup: "./test/global-setup.ts",
  use: {
    baseURL: process.env.BASE_URL ?? "https://localhost",
    ignoreHTTPSErrors: true,
    storageState: STATE,
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
  },
});
