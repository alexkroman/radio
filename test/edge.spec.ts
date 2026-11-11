// Edge cases: odd titles and show files, missing music, bad input, traversal,
// listener counting. Fixtures: test/fixtures/{shows,music}/{edge,plain,empty}.
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { adminRequest, listen, month, performances, streamHead } from "./helpers.ts";

test("titles with unicode, pipes and HTML show exactly as tagged", async ({ page }) => {
  await page.goto("/edge");
  await expect(async () => {
    await page.reload();
    await expect(page.locator("#np h2")).toHaveText("Café | Olé <b>", {
      timeout: 1000,
    });
  }).toPass();
  await expect(page.locator("#np p")).toHaveText("Zoë Ñandú");
  await expect(page.locator("main b")).toHaveCount(0);
});

test("report keeps unicode and the whole title when it contains a pipe", async () => {
  const admin = await adminRequest();
  await expect.poll(() => performances(admin, "ZOË ÑANDÚ", "CAFÉ  OLÉ <B>")).toBeGreaterThan(0);
  await admin.dispose();
});

test("front matter with CRLF line endings and a quoted title", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('a.show-card[href="/edge"]')).toBeVisible();
  await page.goto("/edge");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Edge Cases");
  await expect(page.locator("main")).not.toContainText("title:");
});

test("a show without front matter is titled by its slug", async ({ page }) => {
  await page.goto("/plain");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("plain");
  await expect(page.locator("main")).toContainText("Just a description, no front matter.");
});

test("an untagged track is shown by its file name, without cover art", async ({ page, request }) => {
  await page.goto("/plain");
  await expect(async () => {
    await page.reload();
    await expect(page.locator("#np h2")).toHaveText("Untitled Thing", {
      timeout: 1000,
    });
  }).toPass();
  expect((await request.get("/plain/cover.jpg")).status()).toBe(404);
  await expect(page.locator("#album-art")).toBeHidden();
});

test("a show with no music folder still streams and renders", async ({ page }) => {
  expect(await streamHead("/empty/stream")).toEqual({
    status: 200,
    type: "audio/mpeg",
    bytes: expect.any(Number),
  });
  await page.goto("/empty");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Empty");
  await expect(page.locator("#np h2")).toHaveCount(0);
});

test("admin rejects malformed months", async () => {
  const admin = await adminRequest();
  for (const m of ["2026-13", "2026-00", "26-01", "2026-1", "", "2026-01x"]) {
    expect((await admin.get(`/admin/report?month=${encodeURIComponent(m)}`)).status(), m).toBe(400);
  }
  expect((await admin.get("/admin/report")).status()).toBe(400);
  await admin.dispose();
});

test("admin rejects a wrong password", async ({ playwright }) => {
  const wrong = await playwright.request.newContext({
    baseURL: process.env.BASE_URL ?? "https://localhost",
    ignoreHTTPSErrors: true,
    httpCredentials: { username: "admin", password: "wrong" },
  });
  expect((await wrong.get("/admin/")).status()).toBe(401);
  await wrong.dispose();
});

test("encoded and dotted paths don't leak files", async ({ request }) => {
  const paths = [
    "/assets/..%2fserver.js",
    "/assets/%2e%2e/server.js",
    "/assets/%2e%2e%2f%2e%2e%2fpackage.json",
    "/assets/..%5c..%5cpackage.json",
    "/..%2fshows/default.md",
    "/%2e%2e/%2e%2e/etc/passwd",
    "/default/cover.jpg/..%2f..%2fdefault.md",
    "/admin%2f",
  ];
  for (const path of paths) {
    const res = await request.get(path);
    expect([400, 401, 404], `${path} → ${res.status()}`).toContain(res.status());
  }
});

test("the report counts every listener connected when a track starts", async () => {
  const admin = await adminRequest();
  const before = await performances(admin, "GAMMA", "MIDNIGHT");
  const stops = [listen("/night/stream"), listen("/night/stream"), listen("/night/stream")];
  // Midnight (20 s) repeats on the night show; wait for it to be logged again.
  await expect
    .poll(() => performances(admin, "GAMMA", "MIDNIGHT"), { timeout: 60_000 })
    .toBeGreaterThanOrEqual(before + 3);
  stops.forEach((stop) => stop());
  await admin.dispose();
});

test("the report matches the play log", async () => {
  const admin = await adminRequest();
  await expect(async () => {
    const lines = (await readFile(`/plays/${month}.jsonl`, "utf8")).trim().split("\n");
    const plays = lines.map((l) => JSON.parse(l) as { show: string; title: string; listeners: number });
    const expected = plays
      .filter((p) => p.show === "night" && p.title === "Midnight")
      .reduce((n, p) => n + Math.max(p.listeners, 1), 0);
    expect(expected).toBeGreaterThan(0);
    expect(await performances(admin, "GAMMA", "MIDNIGHT")).toBe(expected);
  }).toPass();
  await admin.dispose();
});
