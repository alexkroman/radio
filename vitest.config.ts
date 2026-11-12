import { defineConfig } from "vitest/config";

// Server tests (app/*.test.ts): the Hono app called in-process with
// app.request(), on the e2e fixtures. Playwright runs test/ (npm run e2e).
export default defineConfig({
  test: {
    include: ["app/**/*.test.ts"],
    env: {
      SITE_PASSWORD: "unit-site",
      SHOWS_DIR: "test/fixtures/shows",
      COVERS_DIR: "test/fixtures/covers",
      TZ: "UTC",
    },
  },
});
