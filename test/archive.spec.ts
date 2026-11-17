// The archive: a show's page lists its recorded blocks (radio.liq records them;
// the overlay's seed service adds two finished ones of the night show,
// night-2026-11-14.mp3 and night-2026-11-13.mp3, 14 s each at 256 kbps,
// untagged, with their track sidecars), Icecast serves them through Caddy,
// and the site's player plays them from the beginning (picking up where it was
// if it drops or is paused), showing each track while it plays, then the show's block before. test/e2e.sh checks the
// recording itself, the play counts and the retention.
import { expect, type Page, test } from "@playwright/test";
import { get, LOGGED_OUT, lockScreen, onAir, player } from "./helpers.ts";

const BLOCK = "/archive/night-2026-11-14.mp3";
const EARLIER = "/archive/night-2026-11-13.mp3";
const TITLE = "Fixture Night #2";
const EARLIER_TITLE = "Fixture Night #1";
const BYTES = 448_888;

test("a show's page lists its blocks, without track names or downloads, and there's no archive page", async ({
  page,
}) => {
  await onAir("default");
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link")).toHaveText(["About"]);
  await page.locator('#schedule a[href="/night"]').first().click();
  await expect(page).toHaveURL(/\/night$/);
  const past = page.locator(".archive-show", { has: page.getByRole("heading", { name: "Past episodes" }) });
  const blocks = past.locator(".archive-block");
  // Numbered (the blocks have no names of their own), with their dates.
  await expect(blocks.locator(".archive-title")).toHaveText([TITLE, EARLIER_TITLE]);
  await expect(blocks.locator(".archive-date")).toHaveText(["Sat, Nov 14", "Fri, Nov 13"]);
  await expect(blocks.locator(".archive-length")).toHaveText(["14 s", "14 s"]);
  await expect(blocks.first().getByRole("button", { name: `Play ${TITLE}` })).toBeVisible();
  // No file links, download attributes or media controls; no tracks.
  await expect(page.locator('a[href$=".mp3"], [download], audio, video')).toHaveCount(0);
  for (const name of ["Midnight", "Second Wind", "First Light", "Gamma"])
    await expect(past).not.toContainText(name);
  expect((await page.request.get("/archive")).status()).toBe(404);
});

test("a block is served whole, or from a range, so a dropped player resumes", async () => {
  const whole = await get(BLOCK);
  expect(whole.status).toBe(200);
  expect(whole.headers["content-type"]).toBe("audio/mpeg");
  expect(whole.headers["content-disposition"]).toBeUndefined();
  expect(whole.headers["server"]).toBeUndefined();
  expect(whole.body.length).toBe(BYTES);
  // A range request (how a browser resumes) gets the rest of the file.
  const ranged = await get(BLOCK, { Range: "bytes=100000-" });
  expect(ranged.status).toBe(206);
  expect(ranged.headers["content-range"]).toBe(`bytes 100000-${BYTES - 1}/${BYTES}`);
  expect(ranged.body.equals(whole.body.subarray(100000))).toBe(true);
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
  await page.goto("/night");
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

type W = { audio: HTMLAudioElement; after?: number[] };
// Play the block to 4 s in, then interrupt it (`how`), and return where it
// plays from after: each time it reports once it's loading again.
async function interrupted(page: Page, how: () => Promise<unknown>) {
  await page.goto("/night");
  await page
    .getByRole("main")
    .getByRole("button", { name: `Play ${TITLE}` })
    .click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as W).audio.currentTime), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(4);
  await page.evaluate(() => {
    const w = window as unknown as W;
    w.audio.addEventListener(
      "loadstart",
      () => {
        w.after = [];
        w.audio.addEventListener(
          "timeupdate",
          () => w.audio.currentTime > 0 && w.after!.push(w.audio.currentTime),
        );
      },
      { once: true },
    );
  });
  await how();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as W).after?.length ?? 0), { timeout: 15_000 })
    .toBeGreaterThan(2);
  return page.evaluate(() => (window as unknown as W).after!);
}

test("a block that drops picks up where it was, not from the beginning", async ({ page }) => {
  // A network error: the player reconnects (in 3 s) and goes back to where it was.
  const after = await interrupted(page, () =>
    page.evaluate(() => (window as unknown as W).audio.dispatchEvent(new Event("error"))),
  );
  expect(Math.min(...after)).toBeGreaterThanOrEqual(4);
  expect(await player(page)).toEqual({ src: BLOCK, playing: true });
  await page
    .getByRole("main")
    .getByRole("button", { name: `Pause ${TITLE}` })
    .click();
});

test("a block paused and played again picks up where it was", async ({ page }) => {
  const main = page.getByRole("main");
  const after = await interrupted(page, async () => {
    await main.getByRole("button", { name: `Pause ${TITLE}` }).click();
    await expect.poll(() => player(page)).toEqual({ src: null, playing: false });
    await main.getByRole("button", { name: `Play ${TITLE}` }).click();
  });
  expect(Math.min(...after)).toBeGreaterThanOrEqual(4);
  expect(await player(page)).toEqual({ src: BLOCK, playing: true });
  await main.getByRole("button", { name: `Pause ${TITLE}` }).click();
});

test("the schedule plays each show's last episode, and the bar goes back to live", async ({ page }) => {
  await onAir("default");
  await page.goto("/");
  const night = page.locator("#schedule .station", { has: page.locator('a[href="/night"]') });
  const pill = night.locator(".pill");
  await expect(pill).toHaveText("Last episode · Nov 14", { useInnerText: true });
  await expect(night).not.toContainText("Midnight");
  // Only shows with an archived block, off air, have one.
  await expect(page.locator("#schedule .pill")).toHaveCount(1);
  // It plays in place, above the row's link.
  await night.getByRole("button", { name: `Play ${TITLE}` }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect.poll(() => player(page)).toEqual({ src: BLOCK, playing: true });
  await expect(pill).toHaveText("Playing last episode", { useInnerText: true });
  await expect(page.locator("#bar-track")).toHaveText("Midnight · Gamma");
  await night.getByRole("button", { name: `Pause ${TITLE}` }).click();
  await expect.poll(() => player(page)).toEqual({ src: null, playing: false });
  await expect(pill).toHaveText("Paused · Nov 14", { useInnerText: true });
  // Back to live: the stream, playing; the pill as it was.
  const bar = page.getByRole("region", { name: "Player" });
  await bar.getByRole("button", { name: "Back to live" }).click();
  await expect.poll(() => player(page)).toEqual({ src: "/stream", playing: true });
  await expect(bar.getByRole("button", { name: "Back to live" })).toHaveCount(0);
  await expect(pill).toHaveText("Last episode · Nov 14", { useInnerText: true });
  await bar.getByRole("button", { name: "Pause Mazes Radio" }).click();
});
test.describe("logged out", () => {
  test.use(LOGGED_OUT);
  test("a block's now.json needs a login; its blocks play without one, like the stream", async ({
    request,
  }) => {
    expect((await request.get("/archive/night-2026-11-14/now.json?t=0")).status()).toBe(401);
    const res = await request.get(BLOCK);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("audio/mpeg");
  });
});
