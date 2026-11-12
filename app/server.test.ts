// The app in-process (app.request), on test/fixtures/shows and a play log
// written here; env from vitest.config.ts.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import type { Play } from "./plays.ts";

const now = Math.floor(Date.now() / 1000);
const play = (p: Partial<Play>): Play => ({
  time: now,
  show: "default",
  artist: "Alpha Artist",
  title: "First Light",
  album: "Album",
  label: "Label",
  isrc: "US1234567890",
  cover: "",
  listeners: 0,
  ...p,
});
const PLAYS = [
  play({ time: now - 120, listeners: 3 }),
  play({
    time: now - 60,
    artist: "Beta & Band",
    title: "Second Wind",
    cover: "default/Beta & Band- Second Wind.jpg",
  }),
  play({ time: now - 30, show: "night", artist: "Gamma", title: "Midnight", listeners: 2 }),
];
let month = "";

let app: (typeof import("./server.tsx"))["app"];
let cookie = "";
let ip = 0;
// Each request from its own client address unless given one (the login throttle counts per IP).
const req = (path: string, init: RequestInit = {}, headers: Record<string, string> = {}) =>
  app.request(path, { ...init, headers: { "x-forwarded-for": `10.0.0.${++ip}`, ...headers } });
const page = (path: string, headers: Record<string, string> = {}) => req(path, {}, { cookie, ...headers });
const login = (body: Record<string, string>, headers: Record<string, string> = {}) =>
  req("/login", { method: "POST", body: new URLSearchParams(body) }, headers);
const admin = (path: string, password = "unit-admin") =>
  req(path, {}, { authorization: `Basic ${btoa(`admin:${password}`)}` });

beforeAll(async () => {
  // The modules read PLAYS_DIR when loaded.
  const dir = await mkdtemp(join(tmpdir(), "plays-"));
  process.env.PLAYS_DIR = dir;
  month = (await import("./plays.ts")).monthOf(new Date());
  await writeFile(join(dir, `${month}.jsonl`), PLAYS.map((p) => JSON.stringify(p)).join("\n") + "\n");
  ({ app } = await import("./server.tsx"));
  const res = await login({ password: "unit-site", next: "/" });
  cookie = res.headers.get("set-cookie")!.split(";")[0]!;
});

describe("site login", () => {
  test("pages need the password", async () => {
    const res = await req("/night");
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('name="next" value="/night"');
  });

  test("a wrong password is refused", async () => {
    const res = await login({ password: "nope", next: "/" });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.text()).toContain("Wrong password");
  });

  test.each([
    ["/night", "/night"],
    ["//evil.example", "/"],
    ["/\\evil.example", "/"],
    ["https://evil.example", "/"],
    ["/a\nb", "/"],
    ["/\r\nSet-Cookie: pwned=1", "/"],
  ])("next %j redirects to %j", async (next, to) => {
    const res = await login({ password: "unit-site", next });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(to);
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly.*Secure|Secure.*HttpOnly/);
  });

  test("a forged cookie is refused", async () => {
    expect((await req("/night", {}, { cookie: "radio_auth=1" })).status).toBe(401);
  });

  test("the login page doesn't reflect markup from the URL", async () => {
    const res = await req("/%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E");
    expect(await res.text()).not.toContain("<script>alert(1)");
  });

  test("a large form isn't read", async () => {
    const res = await login({ password: "x".repeat(5000), next: "/" });
    expect(res.status).toBe(413);
  });

  test("ten failed logins lock a client out", async () => {
    const from = { "x-forwarded-for": "192.0.2.1" };
    for (let i = 0; i < 10; i++) expect((await login({ password: "nope" }, from)).status).toBe(401);
    expect((await login({ password: "unit-site" }, from)).status).toBe(429);
    expect((await login({ password: "unit-site" }, { "x-forwarded-for": "192.0.2.2" })).status).toBe(303);
  });

  test("assets and favicons stay public", async () => {
    expect((await req("/favicon.ico")).status).not.toBe(401);
    expect((await req("/assets/app.js")).status).not.toBe(401);
    expect((await req("/assets/nope.js")).status).toBe(404);
  });
});

describe("pages", () => {
  test("the stations list shows each show's latest play", async () => {
    const res = await page("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Fixture Default");
    expect(html).toContain("Second Wind");
    expect(html).toContain("Midnight");
    expect(html).toContain('<div id="player" data-slug="default" data-title="Fixture Default"></div>');
  });

  test("a station page shows its now playing and history", async () => {
    const html = await (await page("/default")).text();
    expect(html).toMatch(/np-track">Second Wind/);
    expect(html).toContain("First Light");
    expect(html).not.toContain("Midnight");
  });

  test("a DJ page lists their shows", async () => {
    const res = await page("/djs/ana-ruiz");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Ana Ruiz");
    expect(html).toContain("Fixture Night");
    expect(html).not.toContain("javascript:");
  });

  test("a DJ's photo is revalidated by its ETag", async () => {
    const res = await page("/djs/ana-ruiz/photo");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBeNull();
    const again = await page("/djs/ana-ruiz/photo", { "if-none-match": res.headers.get("etag")! });
    expect(again.status).toBe(304);
  });

  test("unknown pages are 404", async () => {
    for (const path of ["/nope", "/djs/nobody", "/djs/nobody/photo", "/empty/cover.jpg"])
      expect((await page(path)).status, path).toBe(404);
  });

  test("a station's cover redirects to its current track's art", async () => {
    const res = await page("/default/cover.jpg");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/covers/default/Beta%20&%20Band-%20Second%20Wind.jpg");
    const art = await page(res.headers.get("location")!);
    expect(art.status).toBe(200);
    expect(art.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  test("an unchanged page is 304 to a request with its ETag", async () => {
    const res = await page("/default");
    const tag = res.headers.get("etag");
    expect(tag).toMatch(/^"[0-9a-f]+"$/);
    const again = await page("/default", { "if-none-match": tag! });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    expect((await page("/night", { "if-none-match": tag! })).status).toBe(200);
  });
});

describe("admin", () => {
  test("needs the admin password", async () => {
    expect((await admin("/admin", "nope")).status).toBe(401);
    const res = await admin("/admin");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`/admin/report?month=${month}`);
  });

  test("the SoundExchange report counts each play's listeners (at least 1)", async () => {
    const res = await admin(`/admin/report?month=${month}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="MAZESRADIO01/);
    const rows = (await res.text()).trim().split("\n");
    expect(rows[0]).toMatch(/^\^NAME_OF_SERVICE\^\|/);
    expect(rows.slice(1)).toEqual([
      "^MAZES RADIO^|^A^|^ALPHA ARTIST^|^FIRST LIGHT^|^US1234567890^|^ALBUM^|^LABEL^|3",
      "^MAZES RADIO^|^A^|^GAMMA^|^MIDNIGHT^|^US1234567890^|^ALBUM^|^LABEL^|2",
      "^MAZES RADIO^|^A^|^BETA & BAND^|^SECOND WIND^|^US1234567890^|^ALBUM^|^LABEL^|1",
    ]);
  });

  test.each(["2026-13", "2026-00", "26-01", "2026-1", "", "2026-01x"])("month %j is refused", async (m) => {
    expect((await admin(`/admin/report?month=${encodeURIComponent(m)}`)).status).toBe(400);
  });

  test("a month without plays is just the header, named for its days", async () => {
    const res = await admin("/admin/report?month=2028-02");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="MAZESRADIO01022028-29022028_A.txt"',
    );
    expect((await res.text()).trim().split("\n")).toHaveLength(1);
    expect((await admin("/admin/report?month=2026-02")).headers.get("content-disposition")).toContain(
      "-28022026_A.txt",
    );
  });
});
