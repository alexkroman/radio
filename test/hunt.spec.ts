// Bug hunt: in-stream metadata, escaping, layout, listener counting, load,
// login hardening and report edge cases. Fixtures: shows/{odd,long}.
import { request as https } from "node:https";
import { expect, test } from "@playwright/test";
import {
  adminRequest,
  BASE,
  icyTitle,
  listen,
  loggedPlays,
  performances,
  SITE_PASSWORD,
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
  await page.getByRole("button", { name: "Play Edge Cases" }).click();
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
    storageState: "test-results/.auth.json",
    httpCredentials: { username: "admin", password: process.env.ADMIN_PASSWORD ?? "" },
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

test.describe("logged out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("the login page doesn't reflect markup from the URL", async ({ request }) => {
    const res = await request.get("/%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E");
    expect(await res.text()).not.toContain("<script>alert(1)");
  });

  test("login can't inject headers through next", async ({ request }) => {
    for (const next of ["/\r\nSet-Cookie: pwned=1", "/x\nX-Injected: 1"]) {
      const res = await request.post("/login", { form: { password: SITE_PASSWORD, next }, maxRedirects: 0 });
      expect(res.status(), JSON.stringify(next)).toBe(303);
      expect(res.headers()["x-injected"]).toBeUndefined();
      expect(
        res.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie" && h.value.includes("pwned")),
      ).toEqual([]);
    }
  });

  test("an unknown asset is 404, not the login page", async ({ request }) => {
    expect((await request.get("/assets/nope.js")).status()).toBe(404);
  });
});

test("admin report: empty months and leap-year February", async () => {
  const admin = await adminRequest();
  const res = await admin.get("/admin/report?month=2028-02");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-disposition"]).toBe(
    'attachment; filename="MAZESRADIO01022028-29022028_A.txt"',
  );
  expect((await res.text()).trim().split("\n")).toHaveLength(1);
  expect((await admin.get("/admin/report?month=2026-02")).headers()["content-disposition"]).toContain(
    "-28022026_A.txt",
  );
  await admin.dispose();
});

// Last: it locks this client out of logging in for a while.
test("repeated wrong passwords are throttled", async ({ playwright }) => {
  const context = await playwright.request.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });
  const statuses: number[] = [];
  for (let i = 0; i < 15; i++) {
    statuses.push(
      (
        await context.post("/login", { form: { password: `wrong-${i}`, next: "/" }, maxRedirects: 0 })
      ).status(),
    );
  }
  expect(statuses).toContain(429);
  await context.dispose();
});
