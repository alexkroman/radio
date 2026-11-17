// Live and archived audio are the same: the same MP3 format (the archive is
// recorded at the stream's 256 kbps), and the same player widgets (bar,
// cover, lock screen) showing a track's title, artist and album, whether it
// plays live or from an archive block. Only the status says which.
import { readdir, readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { firstBytes, mp3Format, onAir, player } from "./helpers.ts";

const FORMAT = { kbps: 256, sampleRate: 44_100, channels: 2 };

test("the live stream, the archive recordings and the served blocks are all 256 kbps MP3, 44.1 kHz stereo", async () => {
  expect(mp3Format(await firstBytes("/stream"))).toEqual(FORMAT);
  // The block radio.liq is recording now (the e2e container mounts the archive).
  const [recording] = (await readdir("/archive/recording")).filter((f) => f.endsWith(".mp3"));
  expect(recording).toBeDefined();
  const recorded = (await readFile(`/archive/recording/${recording}`)).subarray(0, 65_536);
  expect(mp3Format(recorded)).toEqual(FORMAT);
  // A finished block, as Icecast serves it.
  expect(mp3Format(await firstBytes("/archive/night-2026-11-14.mp3"))).toEqual(FORMAT);
});

// What the player shows: the bar's text, cover and button, the shape of the
// bar (its elements, without their text, but for the status, whose icon says
// which), and the lock screen.
const widgets = (page: Page) =>
  page.evaluate(() => {
    const bar = document.getElementById("bar")!;
    const shape = [...bar.querySelectorAll("*")]
      .filter((el) => !el.closest(".bar-status"))
      .map((el) => `${el.tagName}.${el.className}`);
    const m = navigator.mediaSession.metadata;
    return {
      track: document.getElementById("bar-track")!.textContent,
      status: bar.querySelector(".bar-status")!.textContent,
      cover: bar.querySelector("img")?.getAttribute("src") ?? null,
      coverAlt: bar.querySelector("img")?.getAttribute("alt") ?? null,
      shape,
      lock: m && { title: m.title, artist: m.artist, album: m.album, artwork: m.artwork.map((a) => a.src) },
    };
  });

test("a track looks the same in the player live and from the archive", async ({ page }) => {
  // Midnight by Gamma, live on the night show, and at the start of the
  // night-2026-11-14 block.
  await onAir("night");
  await page.goto("/");
  const main = page.getByRole("main");
  const bar = page.getByRole("region", { name: "Player" });
  await main.getByRole("button", { name: "Play Mazes Radio" }).first().click();
  await expect.poll(() => player(page)).toEqual({ src: "/stream", playing: true });
  await expect(page.locator("#bar-track")).toHaveText("Midnight · Gamma");
  await expect(bar.locator("img")).toBeVisible();
  await expect.poll(async () => (await widgets(page)).lock?.title).toBe("Midnight");
  const live = await widgets(page);

  // On the show's page (the schedule offers no episode of the show on air).
  await page.locator('#on-air a[href="/night"]').click();
  await expect(page).toHaveURL(/\/night$/);
  await main.locator('button[data-play="/archive/night-2026-11-14.mp3"]').click();
  await expect.poll(() => player(page)).toEqual({ src: "/archive/night-2026-11-14.mp3", playing: true });
  await expect(page.locator("#bar-track")).toHaveText("Midnight · Gamma");
  await expect(bar.locator("img")).toBeVisible();
  await expect.poll(async () => (await widgets(page)).lock?.title).toBe("Midnight");
  const archived = await widgets(page);

  expect(live.status).toBe("Fixture Night · Live");
  expect(archived.status).toBe("Fixture Night #2");
  // Everything else is the same.
  expect({ ...archived, status: "" }).toEqual({ ...live, status: "" });
  expect(live.lock).toEqual({
    title: "Midnight",
    artist: "Gamma",
    album: "",
    artwork: [expect.stringMatching(/\/covers\/night\/Gamma-%20Midnight\.jpg$/)],
  });
});
