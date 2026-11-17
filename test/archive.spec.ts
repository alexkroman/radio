// The archive: /archive lists recorded show blocks (radio.liq records them;
// the overlay's seed service adds two finished ones of the night show,
// night-2026-11-14.mp3 and night-2026-11-13.mp3, 14 s each at 256 kbps,
// untagged, with their track sidecars), Icecast serves them through Caddy,
// and the site's player plays them from the beginning, showing each track
// while it plays, then the show's block before. test/e2e.sh checks the
// recording itself, the play counts and the retention.
import { expect, test } from "@playwright/test";
import { get, LOGGED_OUT, lockScreen, player } from "./helpers.ts";

const BLOCK = "/archive/night-2026-11-14.mp3";
const EARLIER = "/archive/night-2026-11-13.mp3";
const TITLE = "Fixture Night #2";
const EARLIER_TITLE = "Fixture Night #1";
const BYTES = 448_888;

test("the archive lists each show's blocks, without track names or downloads", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Archive", exact: true }).click();
  await expect(page).toHaveURL(/\/archive$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Archive");
  const night = page.locator(".archive-show", { has: page.getByRole("heading", { name: "Fixture Night" }) });
  const blocks = night.locator(".archive-block");
  // Numbered (the blocks have no names of their own), with their dates.
  await expect(blocks.locator(".archive-title")).toHaveText([TITLE, EARLIER_TITLE]);
  await expect(blocks.locator(".archive-date")).toHaveText(["Sat, Nov 14", "Fri, Nov 13"]);
  await expect(blocks.locator(".archive-length")).toHaveText(["14 s", "14 s"]);
  await expect(blocks.first().getByRole("button", { name: `Play ${TITLE}` })).toBeVisible();
  // No file links, download attributes or media controls; no tracks.
  await expect(page.locator('a[href$=".mp3"], [download], audio, video')).toHaveCount(0);
  for (const name of ["Midnight", "Second Wind", "First Light", "Gamma"])
    await expect(page.locator("main")).not.toContainText(name);
});

test("a block is served from the beginning only, as a stream with no length", async () => {
  const whole = await get(BLOCK);
  expect(whole.status).toBe(200);
  expect(whole.headers["content-type"]).toBe("audio/mpeg");
  expect(whole.headers["content-length"]).toBeUndefined();
  expect(whole.headers["accept-ranges"]).toBeUndefined();
  expect(whole.headers["content-disposition"]).toBeUndefined();
  expect(whole.headers["server"]).toBeUndefined();
  expect(whole.body.length).toBe(BYTES);
  // A range request gets the whole file, from the start.
  const ranged = await get(BLOCK, { Range: "bytes=100000-" });
  expect(ranged.status).toBe(200);
  expect(ranged.body.equals(whole.body)).toBe(true);
  // Only GET reaches the file; anything else under /archive is the app's.
  expect([401, 404]).toContain((await get(BLOCK, {}, "HEAD")).status);
  expect((await get("/archive/night-2026-11-10.mp3")).status).toBe(404);
  for (const path of [
    "/archive/recording/night-2026-11-14.mp3",
    "/archive/tracks/night-2026-11-14.jsonl",
    "/archive/night-2026-11-14.jsonl",
    "/archive/../status-json.xsl",
    "/archive/",
  ])
    expect((await get(path)).body.toString(), path).not.toMatch(/icecast|Midnight/i);
});

test("a block's now.json has only the track playing at a time into it", async ({ request }) => {
  const at = async (t: number) => (await request.get(`/archive/night-2026-11-14/now.json?t=${t}`)).json();
  // With when it ends, so the player asks again only then.
  expect(await at(0)).toEqual({
    track: "Midnight",
    artist: "Gamma",
    album: "",
    cover: "/covers/night/Gamma-%20Midnight.jpg",
    until: 6,
  });
  expect(await at(7)).toEqual({
    track: "Second Wind",
    artist: "Beta & Band",
    album: "",
    cover: "/covers/default/Beta%20&%20Band-%20Second%20Wind.jpg",
  });
  expect((await request.get("/archive/night-2026-11-10/now.json?t=0")).status()).toBe(404);
});

test("the player plays a block with each track as it plays, then the show's block before, then stops", async ({
  page,
}) => {
  await page.goto("/archive");
  const main = page.getByRole("main");
  const bar = page.getByRole("region", { name: "Player" });
  await main.getByRole("button", { name: `Play ${TITLE}` }).click();
  await expect.poll(() => player(page)).toEqual({ src: BLOCK, playing: true });
  await expect(main.getByRole("button", { name: `Pause ${TITLE}` })).toBeVisible();
  await expect(bar).toContainText(`${TITLE} · Archive`);
  // Each track while it plays, never before.
  await expect(page.locator("#bar-track")).toHaveText("Midnight · Gamma");
  await expect(bar.getByRole("img", { name: "Cover art: Midnight, Gamma" })).toBeVisible();
  expect(await lockScreen(page)).toEqual({ title: "Midnight", artist: "Gamma", album: "" });
  await expect(page.locator("#bar-track")).toHaveText("Second Wind · Beta & Band", { timeout: 20_000 });
  expect(
    await page.evaluate(() => (window as unknown as { audio: HTMLAudioElement }).audio.currentTime),
  ).toBeGreaterThanOrEqual(6);
  await expect
    .poll(() => lockScreen(page))
    .toEqual({ title: "Second Wind", artist: "Beta & Band", album: "" });
  // No seek bar or download: no media element or slider on the page.
  await expect(page.locator('audio, video, input, [role="slider"]')).toHaveCount(0);
  // Browsing keeps it playing.
  await page.getByRole("link", { name: "About", exact: true }).click();
  await expect(bar).toContainText(`${TITLE} · Archive`);
  expect((await player(page)).playing).toBe(true);

  // At its end, the show's block before it plays, with its own tracks.
  await expect.poll(() => player(page), { timeout: 30_000 }).toEqual({ src: EARLIER, playing: true });
  await expect(bar).toContainText(`${EARLIER_TITLE} · Archive`);
  await expect(page.locator("#bar-track")).toHaveText("First Light · Alpha Artist · Fixture LP");
  await expect
    .poll(() => lockScreen(page))
    .toEqual({
      title: "First Light",
      artist: "Alpha Artist",
      album: "Fixture LP",
    });
  // After the last, back to the live stream, paused.
  await expect(bar).toContainText("· Live", { timeout: 30_000 });
  await expect(bar.getByRole("button", { name: "Play Mazes Radio" })).toBeVisible();
  expect(await player(page)).toEqual({ src: null, playing: false });
  await bar.getByRole("button", { name: "Play Mazes Radio" }).click();
  await expect.poll(() => player(page)).toEqual({ src: "/stream", playing: true });
});

test("the schedule plays each show's last archived show", async ({ page }) => {
  await page.goto("/");
  const night = page.locator("#schedule .station", { has: page.locator('a[href="/night"]') });
  await expect(night.locator(".station-archive")).toContainText("Latest episode");
  await expect(night.locator(".station-archive")).toContainText("#2 · Sat, Nov 14");
  await expect(night).not.toContainText("Midnight");
  // Only shows with an archived block have one.
  await expect(page.locator("#schedule .station-archive")).toHaveCount(1);
  // It plays in place, above the card's link.
  await night.getByRole("button", { name: `Play ${TITLE}` }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect.poll(() => player(page)).toEqual({ src: BLOCK, playing: true });
  await expect(page.locator("#bar-track")).toHaveText("Midnight · Gamma");
  await night.getByRole("button", { name: `Pause ${TITLE}` }).click();
  await expect.poll(() => player(page)).toEqual({ src: null, playing: false });
});
test.describe("logged out", () => {
  test.use(LOGGED_OUT);
  test("the archive page needs a login; its blocks play without one, like the stream", async ({
    request,
  }) => {
    expect((await request.get("/archive")).status()).toBe(401);
    expect((await request.get("/archive/night-2026-11-14/now.json?t=0")).status()).toBe(401);
    const res = await request.get(BLOCK);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("audio/mpeg");
  });
});
