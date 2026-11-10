// End-to-end tests against the real stack (Caddy, Icecast, Liquidsoap, site,
// admin) running on test/fixtures. Run with `npm run e2e`.
import { expect, test } from "@playwright/test";
import { ADMIN, BASE, month, signedIn, streamHead } from "./helpers.ts";

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
  await signedIn(page);
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: "Fixture Default" }),
  ).toHaveAttribute("href", "/default");
  await expect(
    page.getByRole("link", { name: "Fixture Night" }),
  ).toHaveAttribute("href", "/night");
  await expect(page.locator("strong", { hasText: "default" })).toBeVisible();
});

test("show page shows its own now playing and history", async ({ page }) => {
  await signedIn(page);
  await page.goto("/night");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Fixture Night",
  );
  await expect(async () => {
    await page.reload();
    await expect(page.locator("#np h2")).toHaveText("Midnight", {
      timeout: 1000,
    });
  }).toPass();
  await expect(page.locator("#np p")).toHaveText("Gamma");
  await expect(
    page.getByRole("link", { name: /\/night\/stream$/ }),
  ).toHaveAttribute("href", "/night/stream");

  await page.goto("/default");
  await expect(async () => {
    await page.reload();
    await expect(page.locator("#np h2")).toHaveText(/First Light|Second Wind/, {
      timeout: 1000,
    });
  }).toPass();
  await expect(page.locator("main")).not.toContainText("Midnight");

  // Icecast logs "&" as "&amp;"; the page must show it once, unescaped.
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
  await signedIn(page);
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
  for (const path of ["/nope", "/nope/cover.jpg"])
    expect((await request.get(path)).status()).toBe(404);
  expect((await streamHead("/nope/stream")).status).toBe(404);
});

test("Icecast internals are not reachable", async ({ playwright }) => {
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

test("security headers are set and the server banner is stripped", async ({
  request,
}) => {
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

test("SoundExchange report counts plays from every show with file tags", async ({
  playwright,
}) => {
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
    expect(text).toMatch(
      /^\^MAZES RADIO\^\|\^A\^\|\^GAMMA\^\|\^MIDNIGHT\^\|\^\^\|\^\^\|\^\^\|\d+$/m,
    );
  }).toPass({ timeout: 80_000 });
  await request.dispose();
});

test("player plays the stream using only self-hosted assets", async ({
  page,
}) => {
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
  await signedIn(page);
  await page.goto("/night");
  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { player: { state: string } }).player.state,
      ),
    )
    .toBe("playing");
  await expect(page.locator("#album-art")).toBeVisible();
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("button", { name: "Play" })).toBeVisible();
  expect(problems).toEqual([]);
});

test("password gate", async ({ page }) => {
  await page.goto("/");
  const gate = page.locator("#gate");
  await gate.getByPlaceholder("Password").fill("wrong");
  await gate.getByRole("button", { name: "Enter" }).click();
  await expect(gate.getByText("Wrong password")).toBeVisible();
  await gate.getByPlaceholder("Password").fill("mazes2026");
  await gate.getByRole("button", { name: "Enter" }).click();
  await expect(gate).toBeHidden();
});
