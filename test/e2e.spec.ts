// End-to-end tests against the real stack (Caddy, Liquidsoap, the app) running
// on test/fixtures. Run with `npm run e2e`; test/global-setup.ts logs in.
import { expect, test } from "@playwright/test";
import { ADMIN, BASE, month, SITE_PASSWORD, streamHead } from "./helpers.ts";

test("each show is its own MP3 stream", async () => {
  for (const show of ["default", "night"]) {
    await expect(async () => {
      expect(await streamHead(`/${show}/stream`)).toEqual({
        status: 200,
        type: "audio/mpeg",
        bytes: expect.any(Number),
      });
    }).toPass({ timeout: 60_000 });
  }
});

test("/stream redirects to the default show", async ({ request }) => {
  const res = await request.get("/stream", { maxRedirects: 0 });
  expect(res.status()).toBe(302);
  expect(res.headers()["location"]).toBe("/default/stream");
});

test("home page lists every show with its description", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Fixture Default" })).toHaveAttribute("href", "/default");
  await expect(page.getByRole("link", { name: "Fixture Night" })).toHaveAttribute("href", "/night");
  await expect(page.locator(".station-desc", { hasText: "default" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Play Fixture Night" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveAccessibleName("Mazes Radio, all stations");
});

test("about page lists every stream", async ({ page }) => {
  await page.goto("/about");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("About");
  await expect(page.getByRole("link", { name: /\/night\/stream$/ })).toHaveAttribute("href", "/night/stream");
  await expect(page.locator(".streams")).toContainText("MP3 · 256 kbps");
});

test("favicons are served without a login", async ({ playwright }) => {
  const request = await playwright.request.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });
  for (const [path, type] of [
    ["/favicon.ico", "image/"],
    ["/favicon.svg", "image/svg+xml"],
    ["/apple-touch-icon.png", "image/png"],
  ]) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(200);
    expect(res.headers()["content-type"], path).toContain(type);
  }
  await request.dispose();
});

test("show page shows its own now playing and history", async ({ page }) => {
  await page.goto("/night");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Fixture Night");
  await expect(async () => {
    await page.reload();
    await expect(page.locator("#np .np-track")).toHaveText("Midnight", {
      timeout: 1000,
    });
  }).toPass();
  await expect(page.locator("#np .np-artist")).toHaveText("Gamma");
  await expect(page.getByRole("link", { name: /\/night\/stream$/ })).toHaveAttribute("href", "/night/stream");

  await page.goto("/default");
  await expect(async () => {
    await page.reload();
    await expect(page.locator("#np .np-track")).toHaveText(/First Light|Second Wind/, {
      timeout: 1000,
    });
  }).toPass();
  await expect(page.locator("main")).not.toContainText("Midnight");

  // "&" must show once, unescaped.
  await expect(async () => {
    await page.reload();
    await expect(page.locator("main")).toContainText("Beta & Band", {
      timeout: 1000,
    });
  }).toPass();
  await expect(page.locator("main")).not.toContainText("&amp;");
});

test("now playing refreshes itself", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  await page.goto("/default");
  const latest = () =>
    page
      .locator("#history time")
      .first()
      .getAttribute("datetime", { timeout: 1000 })
      .catch(() => null);
  const before = await latest();
  await expect.poll(latest, { timeout: 60_000 }).not.toBe(before);
  expect(problems).toEqual([]);
});

test("cover art of the current track is served", async ({ request }) => {
  await expect(async () => {
    const res = await request.get("/night/cover.jpg");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("image/jpeg");
  }).toPass();
});

test("unknown shows are 404", async ({ request }) => {
  for (const path of ["/nope", "/nope/cover.jpg"]) expect((await request.get(path)).status()).toBe(404);
  expect((await streamHead("/nope/stream")).status).toBe(404);
});

test("only the app and the show streams are reachable", async ({ playwright }) => {
  const paths = [
    "/status-json.xsl",
    "/status.xsl",
    "/server_version.xsl",
    "/admin/stats",
    "/admin/listmounts",
    "/admin/metadata",
    "/default.md",
    "/night/../status-json.xsl",
    "/style.css",
  ];
  for (const httpCredentials of [undefined, ADMIN]) {
    const request = await playwright.request.newContext({
      baseURL: BASE,
      ignoreHTTPSErrors: true,
      httpCredentials,
    });
    for (const path of paths) {
      const res = await request.get(path);
      expect([401, 404], `${path} → ${res.status()}`).toContain(res.status());
      expect(await res.text()).not.toMatch(/icecast/i);
    }
    await request.dispose();
  }
});

test("security headers are set and the server banner is stripped", async ({ request }) => {
  const headers = (await request.get("/")).headers();
  expect(headers["content-security-policy"]).toContain("default-src 'self'");
  expect(headers["strict-transport-security"]).toContain("max-age=");
  expect(headers["server"]).toBeUndefined();
});

test("admin requires a password", async ({ request, playwright }) => {
  expect((await request.get("/admin/")).status()).toBe(401);
  const authed = await playwright.request.newContext({
    baseURL: BASE,
    ignoreHTTPSErrors: true,
    httpCredentials: ADMIN,
  });
  const res = await authed.get("/admin/");
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain(`/admin/report?month=${month}`);
  await authed.dispose();
});

test("SoundExchange report counts plays from every show with file tags", async ({ playwright }) => {
  const request = await playwright.request.newContext({
    baseURL: BASE,
    ignoreHTTPSErrors: true,
    httpCredentials: ADMIN,
  });
  await expect(async () => {
    const res = await request.get(`/admin/report?month=${month}`);
    expect(res.headers()["content-disposition"]).toMatch(
      /^attachment; filename="MAZESRADIO01\d{6}-\d{8}_A\.txt"$/,
    );
    const text = await res.text();
    expect(text).toMatch(/^\^NAME_OF_SERVICE\^\|/);
    expect(text).toMatch(
      /^\^MAZES RADIO\^\|\^A\^\|\^ALPHA ARTIST\^\|\^FIRST LIGHT\^\|\^USFIX2600001\^\|\^FIXTURE LP\^\|\^FIXTURE RECORDS\^\|\d+$/m,
    );
    expect(text).toMatch(
      /^\^MAZES RADIO\^\|\^A\^\|\^BETA & BAND\^\|\^SECOND WIND\^\|\^\^\|\^\^\|\^\^\|\d+$/m,
    );
    expect(text).toMatch(/^\^MAZES RADIO\^\|\^A\^\|\^GAMMA\^\|\^MIDNIGHT\^\|\^\^\|\^\^\|\^\^\|\d+$/m);
  }).toPass({ timeout: 80_000 });
  await request.dispose();
});

test("player plays the stream using only self-hosted assets", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(e.message));
  page.on(
    "request",
    (r) =>
      !r.url().startsWith(BASE) &&
      !/^(blob|data):/.test(r.url()) &&
      problems.push(`external request: ${r.url()}`),
  );
  const state = () => page.evaluate(() => (window as unknown as { player: { state: string } }).player.state);
  await page.goto("/night");
  await page.getByRole("button", { name: "Play Fixture Night" }).click();
  await expect(page.getByRole("button", { name: "Pause Fixture Night" })).toBeVisible();
  await expect(page.locator("[data-status=night]")).toHaveText("Listening · Live");
  await expect.poll(state).toBe("playing");
  await expect(page.locator("#np img")).toBeVisible();

  // Browsing keeps it playing, and the list shows which station is on.
  await page.getByRole("link", { name: "About", exact: true }).click();
  await expect(page).toHaveURL(/\/about$/);
  await expect(page).toHaveTitle(/^About/);
  await page.getByRole("link", { name: "Stations", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause Fixture Night" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Play Fixture Default" })).toBeVisible();
  expect(await state()).toBe("playing");

  // Starting another station stops this one.
  await page.getByRole("button", { name: "Play Fixture Default" }).click();
  await expect(page.getByRole("button", { name: "Pause Fixture Default" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Play Fixture Night" })).toBeVisible();
  await expect.poll(state).toBe("playing");
  await page.getByRole("button", { name: "Pause Fixture Default" }).click();
  await expect(page.getByRole("button", { name: "Play Fixture Default" })).toBeVisible();
  expect(problems).toEqual([]);
});

test("the phone player bar shows while playing", async ({ browser }) => {
  const context = await browser.newContext({
    baseURL: BASE,
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
    storageState: "test-results/.auth.json",
  });
  const page = await context.newPage();
  await page.goto("/");
  const bar = page.getByRole("region", { name: "Player" });
  await expect(bar).toBeHidden();
  await page.getByRole("button", { name: "Play Fixture Night" }).click();
  await expect(bar).toBeVisible();
  await expect(bar).toContainText("Fixture Night · Live");
  await expect(bar).toContainText("Midnight · Gamma");
  await bar.getByRole("button", { name: "Pause Fixture Night" }).click();
  await expect(bar).toBeHidden();
  await context.close();
});

test("the stream URL can be copied", async ({ browser }) => {
  const context = await browser.newContext({
    baseURL: BASE,
    ignoreHTTPSErrors: true,
    storageState: "test-results/.auth.json",
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const page = await context.newPage();
  await page.goto("/night");
  await page.getByRole("button", { name: "Copy" }).click();
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${BASE}/night/stream`);
  await expect(page.getByRole("button", { name: "Copy" })).toBeVisible();
  await context.close();
});

test.describe("site password", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("pages need a login; streams and assets don't", async ({ page, request }) => {
    expect((await request.get("/night")).status()).toBe(401);
    expect((await request.get("/night/cover.jpg")).status()).toBe(401);
    expect((await request.get("/assets/app.css")).status()).toBe(200);
    expect((await streamHead("/night/stream")).status).toBe(200);

    await page.goto("/night");
    await page.getByPlaceholder("Password").fill("wrong");
    await page.getByRole("button", { name: "Enter" }).click();
    await expect(page.getByText("Wrong password")).toBeVisible();
    await page.getByPlaceholder("Password").fill(SITE_PASSWORD);
    await page.getByRole("button", { name: "Enter" }).click();
    await expect(page).toHaveURL(/\/night$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Fixture Night");
    const cookie = (await page.context().cookies()).find((c) => c.name === "radio_auth");
    expect(cookie).toMatchObject({ httpOnly: true, secure: true });
  });

  test("login only redirects within the site", async ({ request }) => {
    for (const next of ["//evil.example", "https://evil.example", "/\\evil.example"]) {
      const res = await request.post("/login", { form: { password: SITE_PASSWORD, next }, maxRedirects: 0 });
      expect(res.status(), next).toBe(303);
      expect(res.headers()["location"], next).toBe("/");
    }
  });

  test("a forged cookie is rejected", async ({ browser }) => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    await context.addCookies([{ name: "radio_auth", value: "1", url: BASE }]);
    expect((await context.request.get(`${BASE}/night`)).status()).toBe(401);
    await context.close();
  });
});
