// End-to-end tests against the real stack (Caddy, Liquidsoap, the app) running
// on test/fixtures. Run with `npm run e2e`; test/global-setup.ts logs in. The
// fixture shows each have three hours of the day; a test that needs one on
// the air puts it there (helpers.ts onAir).
import { expect, test } from "@playwright/test";
import {
  BASE,
  LOGGED_OUT,
  month,
  onAir,
  player,
  playerState,
  SITE_PASSWORD,
  streamHead,
  waitForTrack,
} from "./helpers.ts";

test("the station is one MP3 stream", async () => {
  await expect(async () => {
    expect(await streamHead("/stream")).toEqual({
      status: 200,
      type: "audio/mpeg",
      bytes: expect.any(Number),
    });
  }).toPass({ timeout: 60_000 });
});

test("home page has what's on", async ({ page }) => {
  await onAir("night");
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveAccessibleName("Mazes Radio, home");
  await expect(page.locator("#on-air h2")).toHaveText("Fixture Night");
  await expect(page.locator("#np .np-track")).toHaveText("Midnight");
  await expect(page.locator("#on-air .credit")).toHaveText("with Ana Ruiz, Ben Cho & Zoë Ñandú");
  await expect(page.getByRole("main").getByRole("button", { name: "Play Mazes Radio" })).toBeVisible();
  // No list of shows: the latest episodes stand for them.
  await expect(page.locator("#schedule")).toHaveCount(0);
  await expect(page.locator("footer").getByRole("link", { name: /\/stream$/ })).toHaveAttribute(
    "href",
    "/stream",
  );
});

test("shows credit their DJs, each linked to a DJ page", async ({ page }) => {
  await page.goto("/night");
  const credit = page.locator(".title-block .credit");
  await expect(credit).toHaveText("with Ana Ruiz, Ben Cho & Zoë Ñandú");
  await expect(credit.getByRole("link", { name: "Zoë Ñandú" })).toHaveAttribute("href", "/djs/zoe-nandu");
  await credit.getByRole("link", { name: "Ben Cho" }).click();
  await expect(page).toHaveURL(/\/djs\/ben-cho$/);
  await page.goto("/default");
  await expect(page.locator(".title-block .credit")).toHaveText("with Ana Ruiz & Ben Cho");
});

test("a DJ page has their profile, shows and links", async ({ page }) => {
  await page.goto("/djs/ana-ruiz");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Ana Ruiz");
  await expect(page.locator(".profile")).toContainText("Brooklyn, NY");
  await expect(page.locator(".lead strong")).toHaveText("records");
  const img = page.getByRole("img", { name: "Photo of Ana Ruiz" });
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  const shows = page.locator(".dj-shows .station");
  await expect(shows.locator(".station-name")).toHaveText(["Fixture Default", "Fixture Night"]);
  await expect(shows.locator(".hours")).toHaveCount(2);
  await expect(shows.locator(".credit")).toHaveCount(0);
  await expect(page.locator(".site-header nav a[aria-current]")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "instagram.com/anaruiz" })).toHaveAttribute(
    "href",
    "https://instagram.com/anaruiz",
  );
  await expect(page.locator(".streams dt")).toHaveText(["Instagram"]);

  // Just a name: no photo, bio or links.
  await page.goto("/djs/zoe-nandu");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Zoë Ñandú");
  await expect(page.locator(".photo")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Elsewhere" })).toHaveCount(0);
});

test("the About page has the stream", async ({ page }) => {
  await page.goto("/about");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("About Mazes Radio");
  await expect(page.getByRole("link", { name: /\/stream$/ })).toHaveAttribute("href", "/stream");
  await expect(page.locator(".streams")).toContainText("MP3, 256 kbps");
});

test("a show on air has its track; one off air, when it's next on", async ({ page }) => {
  await onAir("night");
  await page.goto("/night");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Fixture Night");
  await expect(page.locator(".title-block")).toContainText(/Daily \d{1,2}:00 [AP]M–\d{1,2}:00 [AP]M/);
  await waitForTrack(page, "Midnight");
  await expect(page.locator("#np .np-artist")).toHaveText("Gamma");

  // Off air: when it's next on, or, during its own hours (12-15 in the
  // stack's time zone) with another show put on air by hand, that it starts
  // after this track. app/server.test.ts pins each wording at a set time.
  await onAir("default");
  await page.goto("/night");
  await expect(page.locator("#np")).toContainText(
    /Off air\. Next on at \d{1,2}:00 [AP]M\.|Starting after this track\./,
  );
  await expect(page.locator("#history")).toContainText("Midnight");
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

test("the home page follows the show on air without a reload", async ({ page }) => {
  await onAir("night");
  await page.goto("/");
  await page.evaluate(() => ((window as unknown as { loaded: boolean }).loaded = true));
  await expect(page.locator("#on-air h2")).toHaveText("Fixture Night");
  await onAir("default");
  await expect(page.locator("#on-air h2")).toHaveText("Fixture Default");
  await expect(page.locator("#np .np-track")).toHaveText(/First Light|Second Wind/);
  // Swapped in by the poll, not a page load.
  expect(await page.evaluate(() => (window as unknown as { loaded?: boolean }).loaded)).toBe(true);
});

test("home page now playing and cover follow the track without a reload", async ({ page }) => {
  // The default fixture plays two 20 s tracks, each with its own cover, in
  // random order: with only two artists, artist separation gives up and the
  // same track can repeat several times, so allow a few minutes for a change.
  test.setTimeout(360_000);
  await onAir("default");
  await page.goto("/");
  await page.evaluate(() => ((window as unknown as { loaded: boolean }).loaded = true));
  const np = page.locator("#np");
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

test("cover art of the track on air is served", async ({ request }) => {
  await onAir("night");
  await expect(async () => {
    const now = await (await request.get("/now.json")).json();
    expect(now).toMatchObject({ title: "Fixture Night", track: "Midnight" });
    const res = await request.get(now.cover);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("image/jpeg");
  }).toPass();
});

// They keep their names across deploys, so a phone mustn't run a stale one.
test("app.js and app.css are revalidated on every load", async ({ request }) => {
  for (const f of ["app.js", "app.css"]) {
    const res = await request.get(`/assets/${f}`);
    expect(res.status(), f).toBe(200);
    expect(res.headers()["cache-control"], f).toBe("no-cache");
  }
});

test("security headers are set and the server banner is stripped", async ({ request }) => {
  const headers = (await request.get("/")).headers();
  expect(headers["content-security-policy"]).toContain("default-src 'self'");
  expect(headers["strict-transport-security"]).toContain("max-age=");
  expect(headers["server"]).toBeUndefined();
});

test("SoundExchange report counts plays from every show with file tags", async ({ page, request }) => {
  await page.goto("/about");
  await page.getByRole("link", { name: "reports", exact: true }).click();
  await expect(page.locator(`a[href="/reports/${month}"]`)).toBeVisible();
  await expect(async () => {
    const res = await request.get(`/reports/${month}`);
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
});

test("player plays the stream using only self-hosted assets", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(e.message));
  page.on("request", (r) => !r.url().startsWith(BASE) && problems.push(`external request: ${r.url()}`));
  const state = () => playerState(page);
  const main = page.getByRole("main");
  await page.goto("/");
  await main.getByRole("button", { name: "Play Mazes Radio" }).click();
  await expect(main.getByRole("button", { name: "Pause Mazes Radio" })).toBeVisible();
  await expect.poll(state).toBe("playing");
  await expect(page.locator("#np img")).toBeVisible();

  // Browsing keeps it playing, and every play button shows it.
  await page.getByRole("link", { name: "About", exact: true }).click();
  await expect(page).toHaveURL(/\/about$/);
  await expect(page).toHaveTitle(/^About/);
  await page.getByRole("link", { name: "Mazes Radio, home" }).click();
  await expect(main.getByRole("button", { name: "Pause Mazes Radio" })).toBeVisible();
  expect(await state()).toBe("playing");
  await main.getByRole("button", { name: "Pause Mazes Radio" }).click();
  await expect(main.getByRole("button", { name: "Play Mazes Radio" })).toBeVisible();
  await expect.poll(state).toBe("stopped");
  expect(problems).toEqual([]);
});

// iOS allows play() only in a tap, and with an AirPlay speaker picked, a
// player that didn't simply point the audio element at the stream and play it
// there left the speaker silent. The element stays the phone's (AirPlay
// carries the phone's output), and the track comes from now.json.
test("play plays the stream in the tap, on the phone's own output", async ({ page }) => {
  await onAir("night");
  await page.addInitScript(() => {
    const w = window as unknown as { inTap: boolean; plays: boolean[] };
    w.plays = [];
    for (const e of ["click", "keydown"])
      addEventListener(e, () => ((w.inTap = true), setTimeout(() => (w.inTap = false))), true);
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      w.plays.push(w.inTap);
      return play.call(this);
    };
  });
  const remote = () =>
    page.evaluate(() => {
      const a = (window as unknown as { audio: HTMLAudioElement }).audio;
      return { disabled: a.disableRemotePlayback, airplay: a.getAttribute("x-webkit-airplay") };
    });
  await page.goto("/");
  await page.getByRole("main").getByRole("button", { name: "Play Mazes Radio" }).click();
  await expect.poll(() => player(page)).toEqual({ src: "/stream", playing: true });
  expect(await page.evaluate(() => (window as unknown as { plays: boolean[] }).plays)).toEqual([true]);
  expect(await remote()).toEqual({ disabled: true, airplay: "deny" });
  // The lock screen's track, artist and album, and the bar's on another page.
  const { track, artist, album } = await (await page.request.get("/now.json")).json();
  await expect.poll(() => page.evaluate(() => navigator.mediaSession.metadata?.title)).toBe(track);
  expect(
    await page.evaluate(() => [
      navigator.mediaSession.metadata?.artist,
      navigator.mediaSession.metadata?.album,
    ]),
  ).toEqual([artist, album]);
  await page.getByRole("link", { name: "About" }).first().click();
  await expect(page).toHaveURL(/\/about$/);
  await expect(page.locator("#bar-track")).toContainText(track);
  // Pausing drops the connection.
  await page.locator("#player").getByRole("button", { name: "Pause Mazes Radio" }).click();
  await expect.poll(() => player(page)).toEqual({ src: null, playing: false });
});

test("pausing and playing again at once keeps playing", async ({ page }) => {
  const state = () => playerState(page);
  await page.goto("/");
  await page.getByRole("main").getByRole("button", { name: "Play Mazes Radio" }).click();
  await expect.poll(state).toBe("playing");
  // Two clicks in one task.
  await page.evaluate(() => {
    const b = document.querySelector<HTMLButtonElement>("main button[data-play]")!;
    b.click();
    b.click();
  });
  await expect(page.getByRole("main").getByRole("button", { name: "Pause Mazes Radio" })).toBeVisible();
  await expect.poll(state).toBe("playing");
  await page.waitForTimeout(2000);
  expect(await state()).toBe("playing");
  await expect(page.getByRole("main").getByRole("button", { name: "Pause Mazes Radio" })).toBeVisible();
});

test("a refresh still in flight when you leave a show page isn't swapped into the next", async ({ page }) => {
  await onAir("night");
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
  await page.getByRole("link", { name: "Mazes Radio, home" }).click();
  await page.getByRole("link", { name: "Fixture Default", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Fixture Default");
  const done = page.waitForEvent("requestfinished", (r) => r.url().endsWith("/night")).catch(() => {});
  release();
  await Promise.race([done, page.waitForTimeout(3000)]);
  await page.waitForTimeout(500); // htmx swaps and settles within ~20 ms of the response
  // Checked once: the default page's own refresh would soon put it right again.
  expect(await page.locator("#np").textContent()).toContain("Off air");
  expect(await page.locator("#history").textContent()).not.toContain("Midnight");
});

for (const [name, viewport] of [
  ["phone", { width: 390, height: 844 }],
  ["desktop", { width: 1440, height: 900 }],
] as const)
  test.describe(() => {
    test.use({ viewport });
    test(`the player bar always shows (${name})`, async ({ page }) => {
      await onAir("night");
      await page.goto("/");
      const bar = page.getByRole("region", { name: "Player" });
      // Paused, with the show on air, before anything plays.
      await expect(bar).toBeVisible();
      await expect(bar).toContainText("Fixture Night · Live");
      await expect(bar).toContainText("Midnight · Gamma");
      await expect(bar.getByRole("img", { name: "Cover art: Midnight, Gamma" })).toBeVisible();
      await expect(bar.getByRole("button", { name: "Play Mazes Radio" })).toBeVisible();
      await page.getByRole("main").getByRole("button", { name: "Play Mazes Radio" }).click();
      await expect(bar.getByRole("button", { name: "Pause Mazes Radio" })).toBeVisible();
      // It (and the stream) stays through navigation.
      await page.getByRole("link", { name: "About" }).click();
      await expect(page).toHaveURL(/\/about$/);
      await expect(bar).toContainText("Fixture Night · Live");
      await bar.getByRole("button", { name: "Pause Mazes Radio" }).click();
      // It stays, paused, and plays again.
      await expect(bar).toBeVisible();
      await expect(bar).toContainText("Fixture Night · Live");
      await bar.getByRole("button", { name: "Play Mazes Radio" }).click();
      await expect(bar.getByRole("button", { name: "Pause Mazes Radio" })).toBeVisible();
    });
  });

test.describe("logged out", () => {
  test.use(LOGGED_OUT);

  test("favicons are served without a login", async ({ request }) => {
    for (const [path, type] of [
      ["/favicon.ico", "image/"],
      ["/favicon.svg", "image/svg+xml"],
      ["/apple-touch-icon.png", "image/png"],
    ]) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(200);
      expect(res.headers()["content-type"], path).toContain(type);
    }
  });

  test("only the app and the stream are reachable", async ({ request }) => {
    const paths = [
      "/status-json.xsl",
      "/status.xsl",
      "/server_version.xsl",
      "/admin/stats",
      "/admin/listmounts",
      "/admin/metadata",
      "/fallback.mp3",
      "/default.md",
      "/stream/../status-json.xsl",
      "/style.css",
    ];
    for (const path of paths) {
      const res = await request.get(path, { maxRedirects: 0 });
      expect([401, 404], `${path} → ${res.status()}`).toContain(res.status());
      expect(await res.text()).not.toMatch(/icecast/i);
    }
  });

  test("pages need a login; the stream and assets don't", async ({ page, request }) => {
    expect((await request.get("/night")).status()).toBe(401);
    expect((await request.get("/now.json")).status()).toBe(401);
    expect((await request.get("/assets/app.css")).status()).toBe(200);
    expect((await streamHead("/stream")).status).toBe(200);

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
});
