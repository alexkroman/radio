// The station and a show's own channel are the same: the same MP3 format,
// and the same player widgets (bar, cover, lock screen) showing a track's
// title, artist and album, whether it plays on the station or the channel.
// Only the status says which.
import { expect, type Page, test } from "@playwright/test";
import { firstBytes, mp3Format, onAir, player } from "./helpers.ts";

const FORMAT = { kbps: 256, sampleRate: 44_100, channels: 2 };

test("the station and the shows' channels are all 256 kbps MP3, 44.1 kHz stereo", async () => {
  expect(mp3Format(await firstBytes("/stream"))).toEqual(FORMAT);
  expect(mp3Format(await firstBytes("/stream/night"))).toEqual(FORMAT);
  expect(mp3Format(await firstBytes("/stream/default"))).toEqual(FORMAT);
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

test("a track looks the same in the player on the station and on its show's channel", async ({ page }) => {
  // Midnight by Gamma, live on the night show, and night's channel's one track.
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

  // On the show's page.
  await page.locator('#on-air a[href="/night"]').click();
  await expect(page).toHaveURL(/\/night$/);
  await main.locator('button[data-play="/stream/night"]').click();
  await expect.poll(() => player(page)).toEqual({ src: "/stream/night", playing: true });
  await expect(page.locator("#bar-track")).toHaveText("Midnight · Gamma");
  await expect(bar.locator("img")).toBeVisible();
  await expect.poll(async () => (await widgets(page)).lock?.title).toBe("Midnight");
  const channel = await widgets(page);

  expect(live.status).toBe("Fixture Night · Live");
  expect(channel.status).toBe("Fixture Night · 24/7");
  // Everything else is the same.
  expect({ ...channel, status: "" }).toEqual({ ...live, status: "" });
  expect(live.lock).toEqual({
    title: "Midnight",
    artist: "Gamma",
    album: "",
    artwork: [expect.stringMatching(/\/covers\/night\/Gamma-%20Midnight\.jpg$/)],
  });
});
