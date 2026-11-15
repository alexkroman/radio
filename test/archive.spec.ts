// The archive: /archive lists recorded show blocks (radio.liq records them;
// the overlay's seed service adds a finished one, night-2026-11-14.mp3, 20 s
// at 128 kbps, untagged), Icecast serves them through Caddy, and the site's
// player plays them from the beginning. test/e2e.sh checks the recording
// itself, the play counts and the retention.
import { request as https } from "node:https";
import { expect, test } from "@playwright/test";
import { BASE, LOGGED_OUT, player } from "./helpers.ts";

const BLOCK = "/archive/night-2026-11-14.mp3";
const TITLE = "Fixture Night, Sat, Nov 14";

// A whole response: status, headers and body.
function get(path: string, headers: Record<string, string> = {}, method = "GET") {
  return new Promise<{ status?: number; headers: Record<string, unknown>; body: Buffer }>(
    (resolve, reject) => {
      const req = https(
        new URL(path, BASE),
        { method, headers, rejectUnauthorized: false, timeout: 30_000 },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
          );
        },
      );
      req.on("timeout", () => req.destroy(new Error(`timeout reading ${path}`)));
      req.on("error", reject);
      req.end();
    },
  );
}

test("the archive lists each show's blocks, without track names or downloads", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Archive", exact: true }).click();
  await expect(page).toHaveURL(/\/archive$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Archive");
  const night = page.locator(".archive-show", { has: page.getByRole("heading", { name: "Fixture Night" }) });
  const block = night.locator(".archive-block");
  await expect(block).toHaveCount(1);
  await expect(block.locator(".archive-title")).toHaveText("Fixture Night");
  await expect(block.locator(".archive-date")).toHaveText("Sat, Nov 14");
  await expect(block.locator(".archive-length")).toHaveText("20 s");
  await expect(block.getByRole("button", { name: `Play ${TITLE}` })).toBeVisible();
  // No file links, download attributes or media controls; no tracks.
  await expect(page.locator('a[href$=".mp3"], [download], audio, video')).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText("Midnight");
  await expect(page.locator("main")).not.toContainText("Gamma");
});

test("a block is served from the beginning only, as a stream with no length", async () => {
  const whole = await get(BLOCK);
  expect(whole.status).toBe(200);
  expect(whole.headers["content-type"]).toBe("audio/mpeg");
  expect(whole.headers["content-length"]).toBeUndefined();
  expect(whole.headers["accept-ranges"]).toBeUndefined();
  expect(whole.headers["content-disposition"]).toBeUndefined();
  expect(whole.headers["server"]).toBeUndefined();
  expect(whole.body.length).toBe(320_574);
  // A range request gets the whole file, from the start.
  const ranged = await get(BLOCK, { Range: "bytes=100000-" });
  expect(ranged.status).toBe(200);
  expect(ranged.body.equals(whole.body)).toBe(true);
  // Only GET reaches the file; anything else under /archive is the app's.
  expect([401, 404]).toContain((await get(BLOCK, {}, "HEAD")).status);
  expect((await get("/archive/night-2026-11-13.mp3")).status).toBe(404);
  for (const path of ["/archive/recording/night-2026-11-14.mp3", "/archive/../status-json.xsl", "/archive/"])
    expect((await get(path)).body.toString(), path).not.toMatch(/icecast/i);
});

test("the player plays a block from the beginning, with no seeking, download or tracks", async ({ page }) => {
  await page.goto("/archive");
  const main = page.getByRole("main");
  await main.getByRole("button", { name: `Play ${TITLE}` }).click();
  await expect.poll(() => player(page)).toEqual({ src: BLOCK, playing: true });
  await expect(main.getByRole("button", { name: `Pause ${TITLE}` })).toBeVisible();
  const bar = page.getByRole("region", { name: "Player" });
  await expect(bar).toContainText(`${TITLE} · Archive`);
  await expect(page.locator("#bar-track")).toHaveText("");
  await expect(bar.locator("img")).toHaveCount(0);
  await expect(bar.locator('input, [role="slider"], a, audio')).toHaveCount(0);
  expect(await page.evaluate(() => navigator.mediaSession.metadata?.title)).toBe(TITLE);
  // No media element on the page, so no native seek bar or download menu
  // (the player's audio element is never attached); seeking is refused by the
  // server too (no ranges, above).
  await expect(page.locator("audio, video")).toHaveCount(0);
  // Browsing keeps it playing.
  await page.getByRole("link", { name: "About", exact: true }).click();
  await expect(bar).toContainText(`${TITLE} · Archive`);
  expect((await player(page)).playing).toBe(true);

  // At its end the player goes back to the live stream, paused.
  await expect(bar).toContainText("· Live", { timeout: 60_000 });
  await expect(bar.getByRole("button", { name: "Play Mazes Radio" })).toBeVisible();
  expect(await player(page)).toEqual({ src: null, playing: false });
  await bar.getByRole("button", { name: "Play Mazes Radio" }).click();
  await expect.poll(() => player(page)).toEqual({ src: "/stream", playing: true });
});

test.describe("logged out", () => {
  test.use(LOGGED_OUT);
  test("the archive page needs a login; its blocks play without one, like the stream", async ({
    request,
  }) => {
    expect((await request.get("/archive")).status()).toBe(401);
    const res = await request.get(BLOCK);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("audio/mpeg");
  });
});
