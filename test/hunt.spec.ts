// Bug hunt: in-stream metadata, escaping, layout, listener counting, load,
// and the login throttle. Fixtures: shows/{odd,long}.
import { request as https } from "node:https";
import { expect, test } from "@playwright/test";
import { STATE } from "./global-setup.ts";
import {
  ADMIN,
  adminRequest,
  BASE,
  icyTitle,
  listen,
  loggedPlays,
  performances,
  streamHead,
} from "./helpers.ts";

const ODD_ARTIST = 'Q "The" Artist';
const ODD_TITLE = "Back\\slash \"Quotes\" & 'Ticks'";

test("in-stream (ICY) metadata is the current track, in UTF-8", async () => {
  expect(await icyTitle("/edge/stream")).toBe("Zoë Ñandú - Café | Olé <b>");
  expect(await icyTitle("/odd/stream")).toBe(`${ODD_ARTIST} - ${ODD_TITLE}`);
});

test("the player picks up track metadata from the stream", async ({ page }) => {
  await page.goto("/edge");
  await page.getByRole("main").getByRole("button", { name: "Play Edge Cases" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          navigator.mediaSession.metadata && [
            navigator.mediaSession.metadata.artist,
            navigator.mediaSession.metadata.title,
          ],
      ),
    )
    .toEqual(["Zoë Ñandú", "Café | Olé <b>"]);
});

test("quotes and backslashes survive the log, the page and the report", async ({ page }) => {
  await expect
    .poll(async () => (await loggedPlays()).find((p) => p.show === "odd"))
    .toMatchObject({ artist: ODD_ARTIST, title: ODD_TITLE });
  await page.goto("/odd");
  await expect(page.locator("#np .np-track")).toHaveText(ODD_TITLE);
  await expect(page.locator("#np .np-artist")).toHaveText(ODD_ARTIST);
  const admin = await adminRequest();
  expect(await performances(admin, 'Q "THE" ARTIST', "BACK\\SLASH \"QUOTES\" & 'TICKS'")).toBeGreaterThan(0);
  await admin.dispose();
});

test("pages fit a 320 px wide phone, even with very long titles", async ({ browser }) => {
  const context = await browser.newContext({
    baseURL: BASE,
    ignoreHTTPSErrors: true,
    viewport: { width: 320, height: 640 },
    storageState: STATE,
    httpCredentials: ADMIN,
  });
  const page = await context.newPage();
  for (const path of ["/", "/long", "/edge", "/admin/"]) {
    await page.goto(path);
    if (path === "/long")
      await expect(page.locator("#np .np-track")).toContainText("Supercalifragilisticexpialidocious");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
  await context.close();
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

test("listener counts return to zero after listeners leave", async () => {
  const stops = [listen("/odd/stream"), listen("/odd/stream")];
  await expect
    .poll(async () => (await loggedPlays()).filter((p) => p.show === "odd").at(-1)?.listeners, {
      timeout: 60_000,
    })
    .toBe(2);
  stops.forEach((stop) => stop());
  // A HEAD request isn't a listener and must not hang.
  await new Promise<void>((resolve, reject) => {
    const req = https(
      new URL("/odd/stream", BASE),
      { method: "HEAD", rejectUnauthorized: false, timeout: 10_000 },
      (res) => {
        res.resume();
        resolve();
      },
    );
    req.on("timeout", () => req.destroy(new Error("HEAD timed out")));
    req.on("error", reject);
    req.end();
  });
  const seen = (await loggedPlays()).length;
  const next = async () => (await loggedPlays()).slice(seen).find((p) => p.show === "odd");
  await expect.poll(next, { timeout: 60_000 }).toBeDefined();
  expect((await next())?.listeners).toBe(0);
});

test("50 simultaneous listeners all get audio", async () => {
  const results = await Promise.all(Array.from({ length: 50 }, () => streamHead("/default/stream")));
  expect(results.filter((r) => r.status === 200 && r.type === "audio/mpeg")).toHaveLength(50);
});

// Last: it locks this client out of logging in for a while.
test("wrong passwords are throttled, even sent all at once", async ({ playwright }) => {
  const context = await playwright.request.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });
  const statuses = await Promise.all(
    Array.from({ length: 30 }, async (_, i) =>
      (
        await context.post("/login", { form: { password: `wrong-${i}`, next: "/" }, maxRedirects: 0 })
      ).status(),
    ),
  );
  // Earlier tests made a wrong attempt or two, so at most 10 get through.
  expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(10);
  expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(20);
  await context.dispose();
});
