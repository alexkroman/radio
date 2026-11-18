// Bug hunt: in-stream metadata, escaping, layout, listener counting, load,
// and the login throttle. Fixtures: shows/{odd,long}.
import { expect, test } from "@playwright/test";
import { complementViolations } from "../app/complement.ts";
import {
  COMPLEMENT_WINDOW,
  icyTitle,
  listen,
  LOGGED_OUT,
  loggedPlays,
  onAir,
  performances,
  streamHead,
} from "./helpers.ts";

const ODD_ARTIST = 'Q "The" Artist';
const ODD_TITLE = "Back\\slash \"Quotes\" & 'Ticks'";

test("in-stream (ICY) metadata is the current track, in UTF-8", async () => {
  // The crossfade into a show's first track takes a few seconds to reach the stream.
  await onAir("edge");
  // With the album, when the track has one.
  await expect.poll(() => icyTitle("/stream")).toBe("Zoë Ñandú - Café | Olé <b> (Édition | Spéciale)");
  await onAir("odd");
  await expect.poll(() => icyTitle("/stream")).toBe(`${ODD_ARTIST} - ${ODD_TITLE}`);
});

test("the player picks up the playing track for the lock screen", async ({ page }) => {
  await onAir("edge");
  await page.goto("/edge");
  await page.getByRole("main").getByRole("button", { name: "Play Mazes Radio" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          navigator.mediaSession.metadata && [
            navigator.mediaSession.metadata.artist,
            navigator.mediaSession.metadata.title,
            navigator.mediaSession.metadata.album,
          ],
      ),
    )
    .toEqual(["Zoë Ñandú", "Café | Olé <b>", "Édition | Spéciale"]);
});

test("quotes and backslashes survive the log, the page and the report", async ({ page, request }) => {
  // Reported once someone hears it.
  const stop = listen("/stream");
  await onAir("odd");
  await expect
    .poll(async () => (await loggedPlays()).find((p) => p.show === "odd"))
    .toMatchObject({ artist: ODD_ARTIST, title: ODD_TITLE });
  await page.goto("/odd");
  await expect(page.locator("#np .np-track")).toHaveText(ODD_TITLE);
  await expect(page.locator("#np .np-artist")).toHaveText(ODD_ARTIST);
  await expect
    .poll(() => performances(request, 'Q "THE" ARTIST', "BACK\\SLASH \"QUOTES\" & 'TICKS'"), {
      timeout: 90_000,
    })
    .toBeGreaterThan(0);
  stop();
});

test.describe(() => {
  test.use({ viewport: { width: 320, height: 640 } });
  test("pages fit a 320 px wide phone, even with very long titles", async ({ page }) => {
    await onAir("long");
    for (const path of ["/", "/long", "/edge", "/reports"]) {
      await page.goto(path);
      if (path === "/long")
        await expect(page.locator("#np .np-track")).toContainText("Supercalifragilisticexpialidocious");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, path).toBeLessThanOrEqual(0);
    }
  });
});

test("history is newest first with valid times", async ({ page }) => {
  await page.goto("/default");
  await expect.poll(() => page.locator("#history time").count()).toBeGreaterThan(0);
  const times = await page
    .locator("#history time")
    .evaluateAll((els) => els.map((e) => Date.parse(e.getAttribute("datetime")!)));
  expect(times.every((t) => !Number.isNaN(t))).toBe(true);
  expect(times).toEqual([...times].sort((a, b) => b - a));
});

test("listener counts return to zero after listeners leave", async ({ request }) => {
  await onAir("odd");
  const stops = [listen("/stream"), listen("/stream")];
  await expect
    .poll(async () => (await loggedPlays()).filter((p) => p.show === "odd").at(-1)?.listeners, {
      timeout: 60_000,
    })
    .toBe(2);
  stops.forEach((stop) => stop());
  // A HEAD request isn't a listener and must not hang.
  await request.head("/stream", { timeout: 10_000 });
  const seen = (await loggedPlays()).length;
  const next = async () => (await loggedPlays()).slice(seen).find((p) => p.show === "odd");
  await expect.poll(next, { timeout: 60_000 }).toBeDefined();
  expect((await next())?.listeners).toBe(0);
});

test("50 simultaneous listeners all get audio", async () => {
  const results = await Promise.all(Array.from({ length: 50 }, () => streamHead("/stream")));
  expect(results.filter((r) => r.status === 200 && r.type === "audio/mpeg")).toHaveLength(50);
});

test("every play in the run kept the performance complement", async () => {
  const plays = await loggedPlays();
  expect(plays.length).toBeGreaterThan(20);
  expect(complementViolations(plays, COMPLEMENT_WINDOW)).toEqual([]);
});

// Last: it locks this client out of logging in for a while.
test.describe(() => {
  test.use(LOGGED_OUT);
  test("wrong passwords are throttled, even sent all at once", async ({ request }) => {
    const statuses = await Promise.all(
      Array.from({ length: 30 }, async (_, i) =>
        (
          await request.post("/login", { form: { password: `wrong-${i}`, next: "/" }, maxRedirects: 0 })
        ).status(),
      ),
    );
    // Earlier tests made a wrong attempt or two, so at most 10 get through.
    expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(10);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(20);
  });
});
