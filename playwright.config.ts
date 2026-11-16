import { defineConfig } from "@playwright/test";
import { STATE } from "./test/global-setup.ts";
import { BASE } from "./test/helpers.ts";

export default defineConfig({
  testDir: "test",
  // Putting a show on air (helpers.ts onAir) waits for the track playing to end.
  timeout: 180_000,
  expect: { timeout: 60_000 },
  reporter: "list",
  // One worker, files in order: hunt.spec.ts ends by locking this client out of logins.
  workers: 1,
  globalSetup: "./test/global-setup.ts",
  use: {
    baseURL: BASE,
    ignoreHTTPSErrors: true,
    storageState: STATE,
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
  },
});
