// The app in-process (app.request), on test/fixtures/shows and a play log
// written here; env from vitest.config.ts.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { Play } from "./plays.ts";
import { showAt } from "./schedule.ts";
import { getShows } from "./shows.ts";

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
// Earlier airings, for the shows' past (by Zed, left out of the report's checks).
const DAY = 86_400;
const zed = (time: number, show: string) => play({ time, show, artist: "Zed", title: `Zed ${show}` });
const EARLIER = [
  zed(now - 20 * DAY, "default"), // ended 20 days ago: too long ago
  zed(now - 20 * DAY + 3600, "night"),
  zed(now - 3 * DAY, "edge"),
  zed(now - 3 * DAY + 3600, "default"), // an hour, one track, 3 days ago
  zed(now - 3 * DAY + 7200, "odd"),
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

beforeAll(async () => {
  // The modules read PLAYS_DIR when loaded.
  const dir = await mkdtemp(join(tmpdir(), "plays-"));
  process.env.PLAYS_DIR = dir;
  // Archived blocks (only their names matter): default's and night's, so only
  // they have anything on their own streams.
  const archive = await mkdtemp(join(tmpdir(), "archive-"));
  process.env.ARCHIVE_DIR = archive;
  await mkdir(join(archive, "blocks"));
  for (const f of ["default-2026-11-14.mp3", "night-2026-11-13.mp3", "nope-2026-11-14.mp3", "notes.txt"])
    await writeFile(join(archive, "blocks", f), "");
  const { monthOf } = await import("./plays.ts");
  month = monthOf(new Date());
  // Each play in its month's log.
  const logs = new Map<string, string>();
  // With end lines: Second Wind had 5 listeners by its end (none as it
  // started), Midnight fewer by its end than its start.
  const END: object[] = [
    { time: now - 60, listeners_at_end: 5 },
    { time: now - 30, listeners_at_end: 1 },
  ];
  for (const p of [...EARLIER, ...PLAYS.slice(0, 2), END[0]!, PLAYS[2]!, END[1]!] as { time: number }[]) {
    const m = monthOf(new Date(p.time * 1000));
    logs.set(m, `${logs.get(m) ?? ""}${JSON.stringify(p)}\n`);
  }
  for (const [m, text] of logs) await writeFile(join(dir, `${m}.jsonl`), text);
  // The shows' own channels (/stream/<show>): newer than the station's last
  // play, but not on air; heard by their listeners only.
  const channel = (show: string, plays: Play[]) =>
    writeFile(join(dir, `${month}.${show}.jsonl`), plays.map((p) => JSON.stringify(p)).join("\n") + "\n");
  await channel("night", [
    play({ time: now - 10, show: "night", artist: "Gamma", title: "Midnight", listeners: 4 }),
  ]);
  await channel("default", [play({ time: now, artist: "Nobody", title: "Unheard", listeners: 0 })]);
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
  test("the home page has the show and track on air and the station's history", async () => {
    const res = await page("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    // On air: the newest play's show.
    expect(html).toMatch(/<h2 class="display"><a href="\/night">Fixture Night<\/a>/);
    expect(html).toMatch(/np-track">Midnight/);
    expect(html).toContain('href="/stream"');
    expect(html).not.toContain("Unheard");
    expect(html).toContain("Second Wind");
    expect(html).toContain('<div id="player" data-title="Mazes Radio"></div>');
  });

  test("a show page has its hours, and its track only while on air", async () => {
    // At 18:00 (UTC, the tests' TZ) today: default's hours (0-3) aren't due,
    // so its page says when it's next on. (Night stays on air: the newest play.)
    const today = new Date();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 18));
    const off = await (await page("/default")).text().finally(() => vi.useRealTimers());
    expect(off).toMatch(
      /Daily <span class="hours"><time class="time" datetime="[^"]+">12:00 AM<\/time>–<time class="time" datetime="[^"]+">3:00 AM</,
    );
    expect(off).toContain("Off air. Next on at");
    expect(off).not.toContain('class="np-track"');
    expect(off).toContain("Second Wind");
    expect(off).toContain("First Light");
    expect(off).not.toContain("Midnight");
    expect(off).not.toContain("Unheard");
    // Its own channel, around the clock.
    expect(off).toContain('href="/stream/default"');
    expect(off).toMatch(/Fixture Default Stream URL: <a class="url" href="\/stream\/default"/);
    const on = await (await page("/night")).text();
    expect(on).toMatch(/np-track">Midnight/);
    expect(on).not.toContain("Off air");
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
    for (const path of ["/nope", "/djs/nobody", "/djs/nobody/photo"])
      expect((await page(path)).status, path).toBe(404);
  });

  test("now.json has the track on air and its show", async () => {
    expect(await (await page("/now.json")).json()).toEqual({
      title: "Fixture Night",
      track: "Midnight",
      artist: "Gamma",
      album: "Album",
      cover: "",
    });
  });

  test("covers are served, cached for an hour", async () => {
    const art = await page("/covers/default/Beta%20&%20Band-%20Second%20Wind.jpg");
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

describe("channels and past shows", () => {
  test("the home page lists the shows, each with an archived block with its own stream's play button", async () => {
    const html = await (await page("/")).text();
    const list = html.slice(html.indexOf('id="shows"'), html.indexOf('id="history"'));
    expect(list).toContain("Shows");
    const plays = [...list.matchAll(/data-play="([^"]+)" data-title="([^"]+)"/g)].map((m) => [m[1], m[2]]);
    expect(plays).toContainEqual(["/stream/night", "Fixture Night"]);
    expect(plays).toContainEqual(["/stream/default", "Fixture Default"]);
    expect(plays.every(([src]) => src!.startsWith("/stream/"))).toBe(true);
    // Quiet has no block: its stream would be silence, so no button, but it's listed.
    expect(list).toContain(">Quiet");
    expect(list).not.toContain("/stream/quiet");
  });

  test("a show's page plays its channel and lists its airings of the last two weeks, newest first", async () => {
    const html = await (await page("/default")).text();
    expect(html).toContain('data-play="/stream/default" data-title="Fixture Default"');
    const past = html.slice(html.indexOf('id="past"'), html.indexOf('id="history"'));
    expect(past).toContain("Past shows");
    expect([...past.matchAll(/class="item-length">([^<]+)</g)].map((m) => m[1])).toEqual([
      "2 tracks",
      "1 track",
    ]);
    // Night's airing that ended 3 days ago is past; the one on air now isn't over.
    const night = await (await page("/night")).text();
    expect([...night.matchAll(/class="item-length">([^<]+)</g)].map((m) => m[1])).toEqual(["1 track"]);
    const quiet = await (await page("/quiet")).text();
    expect(quiet).toContain("Not on the station in the last two weeks.");
    // No archived block: nothing to play on its own stream.
    expect(quiet).not.toContain("Around the clock");
    expect(quiet).not.toContain("/stream/quiet");
  });

  test("a DJ page's shows play their channels", async () => {
    expect(await (await page("/djs/ana-ruiz")).text()).toMatch(
      /class="station-play"><button[^>]*data-play="\/stream\//,
    );
  });

  test("a channel's now.json has the track playing on it, and its show", async () => {
    expect(await (await page("/night/now.json")).json()).toEqual({
      title: "Fixture Night",
      track: "Midnight",
      artist: "Gamma",
      album: "Album",
      cover: "",
    });
    expect((await page("/nope/now.json")).status).toBe(404);
    expect((await req("/night/now.json")).status).toBe(401);
  });

  test("there's no archive", async () => {
    expect((await page("/archive")).status).toBe(404);
    expect((await page("/archive/night-2026-11-14/now.json?t=0")).status).toBe(404);
    expect(await (await page("/")).text()).not.toContain("/archive");
  });

  test("while a show waits for the last one's track to end, its page says it starts after this track", async () => {
    // Night is on air (the newest play); whichever show's hours it is now is due.
    const due = showAt(await getShows(), new Date());
    if (!due || due.slug === "night") return;
    expect(await (await page(`/${due.slug}`)).text()).toContain("Starting after this track.");
  });
});

describe("about", () => {
  test("is linked from the site", async () => {
    expect(await (await page("/")).text()).toContain('href="/about"');
    expect((await page("/about")).status).toBe(200);
    // Browsers that cached /about's old 301 to /manifesto still get the page.
    expect(await (await page("/manifesto")).text()).toContain('class="page page-about"');
    expect(await (await page("/about")).text()).toContain('href="https://github.com/alexkroman/radio"');
    expect(await (await page("/about")).text()).toContain(
      "A nonprofit alternative to Spotify&#39;s AI playlists.",
    );
  });

  test("links each statute the station plays under", async () => {
    const html = await (await page("/about")).text();
    for (const url of [
      "https://www.law.cornell.edu/uscode/text/17/114#d_2",
      "https://www.law.cornell.edu/uscode/text/17/114#j_13",
      "https://www.law.cornell.edu/uscode/text/17/114#d_2_C_ii",
      "https://www.law.cornell.edu/uscode/text/17/114#d_2_C_iii",
      "https://www.law.cornell.edu/uscode/text/17/114#d_2_C_vi",
      "https://www.law.cornell.edu/uscode/text/17/114#d_2_C_ix",
      "https://www.law.cornell.edu/uscode/text/17/114#g_2",
      "https://www.law.cornell.edu/uscode/text/17/112#e",
      "https://www.law.cornell.edu/cfr/text/37/part-380",
      "https://www.law.cornell.edu/cfr/text/37/part-370",
    ])
      expect(html).toContain(`href="${url}"`);
    expect(html).toContain("Every show, around the clock");
  });
});

describe("reports", () => {
  test("are linked from the About page, not the nav, and list this month", async () => {
    expect(await (await page("/")).text()).not.toContain('href="/reports"');
    expect(await (await page("/about")).text()).toContain('href="/reports"');
    const res = await page("/reports");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`href="/reports/${month}"`);
  });

  test("need only the site password, like every page", async () => {
    expect((await req("/reports")).status).toBe(401);
    expect((await req(`/reports/${month}`)).status).toBe(401);
  });

  test("the SoundExchange report counts each play's listeners, the more of its start and end", async () => {
    const res = await page(`/reports/${month}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="MAZESRADIO01/);
    const rows = (await res.text()).trim().split("\n");
    expect(rows[0]).toMatch(/^\^NAME_OF_SERVICE\^\|/);
    // Midnight: 2 on the station, 4 on night's stream. Nobody heard Unheard
    // (on default's stream): not listed.
    expect(rows.slice(1).filter((r) => !r.includes("^ZED^"))).toEqual([
      "^MAZES RADIO^|^A^|^GAMMA^|^MIDNIGHT^|^US1234567890^|^ALBUM^|^LABEL^|6",
      "^MAZES RADIO^|^A^|^BETA & BAND^|^SECOND WIND^|^US1234567890^|^ALBUM^|^LABEL^|5",
      "^MAZES RADIO^|^A^|^ALPHA ARTIST^|^FIRST LIGHT^|^US1234567890^|^ALBUM^|^LABEL^|3",
    ]);
  });

  test.each(["2026-13", "2026-00", "26-01", "2026-1", "2026-01x"])("month %j is not found", async (m) => {
    expect((await page(`/reports/${encodeURIComponent(m)}`)).status).toBe(404);
  });

  test("a month without plays is just the header, named for its days", async () => {
    const res = await page("/reports/2028-02");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="MAZESRADIO01022028-29022028_A.txt"',
    );
    expect((await res.text()).trim().split("\n")).toHaveLength(1);
    expect((await page("/reports/2026-02")).headers.get("content-disposition")).toContain("-28022026_A.txt");
  });
});
