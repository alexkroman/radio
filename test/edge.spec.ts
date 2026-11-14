// Edge cases: odd titles and show files, missing music, traversal,
// listener counting. Fixtures: test/fixtures/{shows,music}/{edge,plain,empty,quiet}.
import { expect, test } from "@playwright/test";
import { icyTitle, listen, loggedPlays, performances, streamHead, waitForTrack } from "./helpers.ts";

test("titles with unicode, pipes and HTML show exactly as tagged", async ({ page }) => {
  await page.goto("/edge");
  await waitForTrack(page, "Café | Olé <b>");
  await expect(page.locator("#np .np-artist")).toHaveText("Zoë Ñandú");
  await expect(page.locator("main b")).toHaveCount(0);
});

test('cover art with a unicode or "&" file name is served', async ({ request }) => {
  expect((await request.get("/covers/default/Beta%20&%20Band-%20Second%20Wind.jpg")).status()).toBe(200);
  await expect(async () => {
    const { cover } = await (await request.get("/edge/now.json")).json();
    expect(cover).toBe("/covers/edge/Zo%C3%AB%20%C3%91and%C3%BA-%20Caf%C3%A9%20_%20Ol%C3%A9%20_b_.jpg");
    const res = await request.get(cover);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("image/jpeg");
  }).toPass();
});

test("an unchanged page or asset is 304 through Caddy's compression", async ({ request }) => {
  for (const path of ["/manifesto", "/assets/app.js"]) {
    const headers = { "accept-encoding": "gzip" };
    const res = await request.get(path, { headers });
    expect(res.headers()["content-encoding"], path).toBe("gzip");
    const tag = res.headers()["etag"];
    expect(tag, path).toBeTruthy();
    const again = await request.get(path, { headers: { ...headers, "if-none-match": tag! } });
    expect(again.status(), path).toBe(304);
  }
});

test("report keeps unicode and the whole title when it contains a pipe", async ({ request }) => {
  await expect.poll(() => performances(request, "ZOË ÑANDÚ", "CAFÉ  OLÉ <B>")).toBeGreaterThan(0);
});

test("an untagged track is shown by its file name, without cover art", async ({ page, request }) => {
  await page.goto("/plain");
  await waitForTrack(page, "Untitled Thing");
  expect((await (await request.get("/plain/now.json")).json()).cover).toBe("");
  await expect(page.locator("#np img")).toHaveCount(0);
  await expect(page.locator("#np .cover-ph")).toBeVisible();
});

test("a show with no music folder still streams and renders", async ({ page }) => {
  expect(await streamHead("/empty/stream")).toEqual({
    status: 200,
    type: "audio/mpeg",
    bytes: expect.any(Number),
  });
  await page.goto("/empty");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Empty");
  await expect(page.locator("#np .np-track")).toHaveCount(0);
});

test("a show with nothing to play streams music/offline.mp3, without logging it", async () => {
  expect(await icyTitle("/empty/stream")).toBe("Mazes Radio - Back soon");
  expect((await loggedPlays()).some((p) => p.title === "Back soon")).toBe(false);
});

test("a track is skipped after 10 s of silence", async () => {
  // Hush- Gap is 4 s of tone, 40 s of silence, 4 s of tone, alone on its show:
  // played through, it restarts every ~47 s.
  await expect
    .poll(
      async () => {
        const times = (await loggedPlays()).filter((p) => p.show === "quiet").map((p) => p.time);
        return Math.min(...times.slice(1).map((t, i) => t - times[i]!));
      },
      { timeout: 90_000 },
    )
    .toBeLessThan(25);
});

test("encoded and dotted paths don't leak files", async ({ request }) => {
  const paths = [
    "/assets/..%2fserver.js",
    "/assets/%2e%2e/server.js",
    "/assets/%2e%2e%2f%2e%2e%2fpackage.json",
    "/assets/..%5c..%5cpackage.json",
    "/..%2fshows/default.md",
    "/%2e%2e/%2e%2e/etc/passwd",
    "/default/now.json/..%2f..%2fdefault.md",
    "/reports%2f2026-01",
  ];
  for (const path of paths) {
    const res = await request.get(path);
    expect([400, 401, 404], `${path} → ${res.status()}`).toContain(res.status());
  }
});

test("the report counts every listener connected when a track starts", async ({ request }) => {
  const before = await performances(request, "GAMMA", "MIDNIGHT");
  const stops = [listen("/night/stream"), listen("/night/stream"), listen("/night/stream")];
  // Midnight (20 s) repeats on the night show; wait for it to be logged again.
  await expect
    .poll(() => performances(request, "GAMMA", "MIDNIGHT"), { timeout: 60_000 })
    .toBeGreaterThanOrEqual(before + 3);
  stops.forEach((stop) => stop());
});

test("the report matches the play log", async ({ request }) => {
  await expect(async () => {
    const expected = (await loggedPlays())
      .filter((p) => p.show === "night" && p.title === "Midnight")
      .reduce((n, p) => n + Math.max(p.listeners, 1), 0);
    expect(expected).toBeGreaterThan(0);
    expect(await performances(request, "GAMMA", "MIDNIGHT")).toBe(expected);
  }).toPass();
});
