// End-to-end tests against the real stack (Caddy, Liquidsoap, the app) running
// on test/fixtures. Run with `npm run e2e`; test/global-setup.ts logs in.
import { expect, test } from "@playwright/test";
import { STATE } from "./global-setup.ts";
import {
  ADMIN,
  adminRequest,
  BASE,
  month,
  playerState,
  SITE_PASSWORD,
  streamHead,
  waitForTrack,
} from "./helpers.ts";

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

test("home page lists every show with its description", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Fixture Default" })).toHaveAttribute("href", "/default");
  await expect(page.getByRole("link", { name: "Fixture Night" })).toHaveAttribute("href", "/night");
  await expect(page.locator(".station-desc", { hasText: "default" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Play Fixture Night" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveAccessibleName("Mazes Radio, all stations");
});

test("tapping anywhere on a station card opens it, but play plays in place", async ({ page }) => {
  await page.goto("/");
  const night = page.locator(".station", { has: page.locator('a[href="/night"]') });
  await night.getByRole("button", { name: "Play Fixture Night" }).click();
  await expect(night.getByRole("button", { name: "Pause Fixture Night" })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await night.getByRole("button", { name: "Pause Fixture Night" }).click();
  // The card's link covers the description, so a real click there lands on it.
  await night.locator(".station-desc").click({ force: true });
  await expect(page).toHaveURL(/\/night$/);
});

test("shows credit their DJs, each linked to a DJ page", async ({ page }) => {
  await page.goto("/");
  const night = page.locator(".station", { has: page.locator('a[href="/night"]') });
  await expect(night.locator(".credit")).toHaveText("with Ana Ruiz, Ben Cho & Zoë Ñandú");
  await expect(night.getByRole("link", { name: "Zoë Ñandú" })).toHaveAttribute("href", "/djs/zoe-nandu");
  // The credit's links sit above the card's link.
  await night.getByRole("link", { name: "Ben Cho" }).click();
  await expect(page).toHaveURL(/\/djs\/ben-cho$/);
  await page.goto("/default");
  await expect(page.locator(".title-block .credit")).toHaveText("with Ana Ruiz & Ben Cho");
});

test("a DJ page has their profile, shows and links", async ({ page, request }) => {
  await page.goto("/djs/ana-ruiz");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Ana Ruiz");
  await expect(page.locator(".profile")).toContainText("Brooklyn, NY");
  await expect(page.locator(".lead strong")).toHaveText("records");
  const img = page.getByRole("img", { name: "Photo of Ana Ruiz" });
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  const shows = page.locator(".dj-shows .station");
  await expect(shows.locator(".station-name")).toHaveText(["Fixture Default", "Fixture Night"]);
  await expect(shows.locator(".credit, .station-num")).toHaveCount(0);
  await expect(page.locator(".site-header nav a[aria-current]")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "instagram.com/anaruiz" })).toHaveAttribute(
    "href",
    "https://instagram.com/anaruiz",
  );
  await expect(page.locator(".streams dt")).toHaveText(["Instagram"]);
  await page.getByRole("button", { name: "Play Fixture Night" }).click();
  await expect(page.getByRole("main").getByRole("button", { name: "Pause Fixture Night" })).toBeVisible();
  await page.getByRole("main").getByRole("button", { name: "Pause Fixture Night" }).click();

  // Just a name: a placeholder photo, no bio or links. A photo outside the
  // allowed image types isn't served.
  await page.goto("/djs/zoe-nandu");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Zoë Ñandú");
  await expect(page.locator(".photo.cover-ph")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Elsewhere" })).toHaveCount(0);
  expect((await request.get("/djs/zoe-nandu/photo")).status()).toBe(404);
  expect((await request.get("/djs/nobody")).status()).toBe(404);
  const photo = await request.get("/djs/ana-ruiz/photo");
  expect(photo.headers()["content-type"]).toBe("image/jpeg");
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
  await waitForTrack(page, "Midnight");
  await expect(page.locator("#np .np-artist")).toHaveText("Gamma");
  await expect(page.getByRole("link", { name: /\/night\/stream$/ })).toHaveAttribute("href", "/night/stream");

  await page.goto("/default");
  await waitForTrack(page, /First Light|Second Wind/);
  await expect(page.locator("main")).not.toContainText("Midnight");

  // "&" must show once, unescaped.
  await expect(async () => {
    await page.reload();
    await expect(page.locator("main")).toContainText("Beta & Band", { timeout: 1000 });
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

test("home page now playing and cover follow the track without a reload", async ({ page }) => {
  // The default fixture plays two 20 s tracks, each with its own cover, in
  // random order: with only two artists, artist separation gives up and the
  // same track can repeat several times, so allow a few minutes for a change.
  test.setTimeout(300_000);
  await page.goto("/");
  await page.evaluate(() => ((window as unknown as { loaded: boolean }).loaded = true));
  const np = page.locator("#np-default");
  const shown = async () => ({
    track: await np
      .locator(".np-track")
      .textContent({ timeout: 1000 })
      .catch(() => null),
    cover: await np
      .locator("img.cover")
      .getAttribute("src", { timeout: 1000 })
      .catch(() => null),
  });
  let before = await shown();
  await expect
    .poll(async () => (before = await shown()).track, { timeout: 60_000 })
    .toMatch(/First Light|Second Wind/);
  expect(before.cover).toContain(encodeURIComponent(before.track!));

  await expect.poll(async () => (await shown()).track, { timeout: 240_000 }).not.toBe(before.track);
  const after = await shown();
  expect(after.track).toMatch(/First Light|Second Wind/);
  expect(after.cover).toContain(encodeURIComponent(after.track!));
  expect(after.cover).not.toBe(before.cover);
  // Swapped in by the poll, not a page load.
  expect(await page.evaluate(() => (window as unknown as { loaded?: boolean }).loaded)).toBe(true);
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

test("admin requires a password", async ({ request }) => {
  expect((await request.get("/admin/")).status()).toBe(401);
  const authed = await adminRequest();
  const res = await authed.get("/admin/");
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain(`/admin/report?month=${month}`);
  await authed.dispose();
});

test("SoundExchange report counts plays from every show with file tags", async () => {
  const request = await adminRequest();
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
  const state = () => playerState(page);
  await page.goto("/night");
  await page.getByRole("button", { name: "Play Fixture Night" }).click();
  await expect(page.getByRole("main").getByRole("button", { name: "Pause Fixture Night" })).toBeVisible();
  await expect(page.locator("[data-status=night]")).toHaveText("Listening · Live");
  await expect.poll(state).toBe("playing");
  await expect(page.locator("#np img")).toBeVisible();

  // Browsing keeps it playing, and the list shows which station is on.
  await page.getByRole("link", { name: "About", exact: true }).click();
  await expect(page).toHaveURL(/\/about$/);
  await expect(page).toHaveTitle(/^About/);
  await page.getByRole("link", { name: "Stations", exact: true }).click();
  await expect(page.getByRole("main").getByRole("button", { name: "Pause Fixture Night" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Play Fixture Default" })).toBeVisible();
  expect(await state()).toBe("playing");

  // Starting another station stops this one.
  await page.getByRole("button", { name: "Play Fixture Default" }).click();
  await expect(page.getByRole("main").getByRole("button", { name: "Pause Fixture Default" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Play Fixture Night" })).toBeVisible();
  await expect.poll(state).toBe("playing");
  await page.getByRole("main").getByRole("button", { name: "Pause Fixture Default" }).click();
  await expect(page.getByRole("button", { name: "Play Fixture Default" })).toBeVisible();
  expect(problems).toEqual([]);
});

test("pausing and playing again at once keeps playing", async ({ page }) => {
  const state = () => playerState(page);
  await page.goto("/night");
  await page.getByRole("button", { name: "Play Fixture Night" }).click();
  await expect.poll(state).toBe("playing");
  // Two clicks in one task: the second lands while the player is still stopping.
  await page.evaluate(() => {
    const b = document.querySelector<HTMLButtonElement>("button[data-play=night]")!;
    b.click();
    b.click();
  });
  await expect(page.getByRole("main").getByRole("button", { name: "Pause Fixture Night" })).toBeVisible();
  await expect.poll(state).toBe("playing");
  await page.waitForTimeout(2000);
  expect(await state()).toBe("playing");
  await expect(page.getByRole("main").getByRole("button", { name: "Pause Fixture Night" })).toBeVisible();
});

// An iPhone has no MediaSource, so the player decodes into one AudioContext,
// which iOS suspends when the audio stops with the phone locked (a server
// restart, say) and lets resume only during a tap.
test("play resumes an AudioContext that iOS suspended", async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as { MediaSource?: unknown }).MediaSource;
    const w = window as unknown as { inTap: boolean; ctx: AudioContext };
    for (const e of ["touchstart", "touchend", "mousedown", "click", "keydown"])
      addEventListener(e, () => ((w.inTap = true), setTimeout(() => (w.inTap = false))), true);
    window.AudioContext = class extends AudioContext {
      constructor(options?: AudioContextOptions) {
        super(options);
        w.ctx = this;
      }
      override resume() {
        return w.inTap ? super.resume() : Promise.reject(new DOMException("not in a tap", "NotAllowedError"));
      }
    };
  });
  const audible = () =>
    page.evaluate(async () => {
      const { ctx } = window as unknown as { ctx: AudioContext };
      const t = ctx.currentTime;
      await new Promise((r) => setTimeout(r, 500));
      return ctx.state === "running" && ctx.currentTime > t;
    });
  await page.goto("/night");
  await page.getByRole("button", { name: "Play Fixture Night" }).click();
  await expect.poll(() => playerState(page)).toBe("playing");
  expect(await audible()).toBe(true);
  await page.getByRole("main").getByRole("button", { name: "Pause Fixture Night" }).click();
  await expect.poll(() => playerState(page)).toBe("stopped");
  // Outside a tap (an evaluate counts as one), as iOS does it.
  await page.evaluate(() =>
    setTimeout(() => void (window as unknown as { ctx: AudioContext }).ctx.suspend()),
  );
  await expect.poll(audible).toBe(false);
  await page.getByRole("button", { name: "Play Fixture Night" }).click();
  await expect.poll(() => playerState(page)).toBe("playing");
  await expect.poll(audible).toBe(true);
});

test("pausing one station and playing another at once plays the other", async ({ page }) => {
  const state = () => playerState(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Play Fixture Default" }).click();
  await expect.poll(state).toBe("playing");
  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>("button[data-play=default]")!.click();
    document.querySelector<HTMLButtonElement>("button[data-play=night]")!.click();
  });
  await expect.poll(state).toBe("playing");
  // The old player's late cleanup must not take over the audio element.
  await page.waitForTimeout(2000);
  expect(await state()).toBe("playing");
  await expect(page.getByRole("main").getByRole("button", { name: "Pause Fixture Night" })).toBeVisible();
});

test("a refresh still in flight when you leave a station page isn't swapped into the next", async ({
  page,
}) => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let polled!: () => void;
  const requested = new Promise<void>((r) => (polled = r));
  await page.route("**/night", async (route) => {
    if (route.request().headers()["hx-trigger"] !== "poll") return route.continue();
    polled();
    await held;
    await route.continue().catch(() => {});
  });
  await page.goto("/night");
  await page.locator("#poll").evaluate((el) => el.dispatchEvent(new Event("refresh")));
  await requested;
  await page.getByRole("link", { name: "Stations", exact: true }).click();
  await page.getByRole("link", { name: "Fixture Default" }).click();
  await expect(page.locator("#np")).toHaveAttribute("data-np", "default");
  const done = page.waitForEvent("requestfinished", (r) => r.url().endsWith("/night")).catch(() => {});
  release();
  await Promise.race([done, page.waitForTimeout(3000)]);
  await page.waitForTimeout(500); // htmx swaps and settles within ~20 ms of the response
  // Checked once: the default page's own refresh would soon put it right again.
  expect(await page.locator("#np").getAttribute("data-np")).toBe("default");
  expect(await page.locator("#history").textContent()).not.toContain("Midnight");
});

for (const [name, viewport] of [
  ["phone", { width: 390, height: 844 }],
  ["desktop", { width: 1440, height: 900 }],
] as const)
  test(`the player bar shows while playing (${name})`, async ({ browser }) => {
    const context = await browser.newContext({
      baseURL: BASE,
      ignoreHTTPSErrors: true,
      viewport,
      storageState: STATE,
    });
    const page = await context.newPage();
    await page.goto("/");
    const bar = page.getByRole("region", { name: "Player" });
    await expect(bar).toBeHidden();
    await page.getByRole("button", { name: "Play Fixture Night" }).click();
    await expect(bar).toBeVisible();
    await expect(bar).toContainText("Fixture Night · Live");
    await expect(bar).toContainText("Midnight · Gamma");
    await expect(bar.getByRole("img", { name: "Cover art: Midnight, Gamma" })).toBeVisible();
    // It (and the stream) stays through navigation.
    await page.getByRole("link", { name: "About" }).click();
    await expect(page).toHaveURL(/\/about$/);
    await expect(bar).toContainText("Fixture Night · Live");
    await bar.getByRole("button", { name: "Pause Fixture Night" }).click();
    await expect(bar).toBeHidden();
    await context.close();
  });

test("the stream URL can be copied", async ({ browser }) => {
  const context = await browser.newContext({
    baseURL: BASE,
    ignoreHTTPSErrors: true,
    storageState: STATE,
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

test("pages and assets are compressed", async ({ request }) => {
  for (const path of ["/", "/assets/app.js"]) {
    const res = await request.get(path, { headers: { "Accept-Encoding": "gzip" } });
    expect(res.headers()["content-encoding"]).toBe("gzip");
  }
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
