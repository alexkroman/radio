// The app in-process (app.request), on test/fixtures/shows and a play log
// written here; env from vitest.config.ts.
import { mkdir, mkdtemp, truncate, utimes, writeFile } from "node:fs/promises";
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
  month = (await import("./plays.ts")).monthOf(new Date());
  await writeFile(join(dir, `${month}.jsonl`), PLAYS.map((p) => JSON.stringify(p)).join("\n") + "\n");
  // The shows' own channels (/stream/<show>): newer than the station's last
  // play, but not on air; heard by their listeners only.
  const channel = (show: string, plays: Play[]) =>
    writeFile(join(dir, `${month}.${show}.jsonl`), plays.map((p) => JSON.stringify(p)).join("\n") + "\n");
  await channel("night", [
    play({ time: now - 10, show: "night", artist: "Gamma", title: "Midnight", listeners: 4 }),
  ]);
  await channel("default", [play({ time: now, artist: "Nobody", title: "Unheard", listeners: 0 })]);
  // Archive blocks (sparse files: only their size matters). 256 kbps is
  // 32,000 bytes a second; archived programs are at least 5 hours.
  const archive = await mkdtemp(join(tmpdir(), "archive-"));
  process.env.ARCHIVE_DIR = archive;
  process.env.ARCHIVE_KEEP = "2";
  for (const d of ["blocks", "recording", "tracks"]) await mkdir(join(archive, d));
  const HOUR = 3600 * 32_000;
  const block = async (name: string, bytes: number, ageMs = 0) => {
    const f = join(archive, name);
    await writeFile(f, "");
    await truncate(f, bytes);
    const at = new Date(Date.now() - ageMs);
    await utimes(f, at, at);
  };
  // radio.liq puts only blocks of 5 hours or more in blocks/; odd's finished last.
  const earlier = 3600 * 1000;
  await block("blocks/night-2026-11-14.mp3", 5 * HOUR + 60 * 32_000, earlier);
  await block("blocks/night-2026-11-13.mp3", 5 * HOUR, earlier);
  await block("blocks/night-2026-11-12.mp3", 5 * HOUR, earlier); // third: ARCHIVE_KEEP is 2
  await block("blocks/odd-2026-11-15.mp3", 6 * HOUR);
  await block("blocks/default-2026-11-14.mp3", 11 * HOUR, earlier);
  await block("blocks/edge-2026-11-02.mp3", 8 * HOUR, (14 * 24 - 2) * 3600 * 1000); // up two weeks less two hours
  await block("blocks/nope-2026-11-14.mp3", 5 * HOUR); // not a show
  await writeFile(join(archive, "tracks", "default-2026-11-10.jsonl"), ""); // a block gone since: default's first
  await block("blocks/notes.txt", 10);
  await block("recording/long-2026-11-15.mp3", 6 * HOUR); // still recording
  const sidecar = (name: string, tracks: object[]) =>
    writeFile(
      join(archive, "tracks", `${name}.jsonl`),
      tracks.map((t) => JSON.stringify(t)).join("\n") + "\n",
    );
  const tags = { label: "Label", isrc: "US1234567890" };
  await sidecar("night-2026-11-14", [
    { offset: 0, title: "Midnight", artist: "Gamma", album: "Album", cover: "", ...tags },
    {
      offset: 10.2,
      title: "Second Wind",
      artist: "Beta & Band",
      album: "Album",
      cover: "default/Beta & Band- Second Wind.jpg",
      ...tags,
    },
  ]);
  await sidecar("odd-2026-11-15", [
    { offset: 0, title: "Track A", artist: "Odd One", album: "", cover: "", label: "", isrc: "" },
    { offset: 9000, title: "Track B", artist: "Odd One", album: "", cover: "", label: "", isrc: "" },
    { offset: 9001, title: "Track C", artist: "Odd One", album: "", cover: "", label: "", isrc: "" },
  ]);
  // Icecast's access log: archive plays (the time connected last), and what isn't one.
  const logs = await mkdtemp(join(tmpdir(), "logs-"));
  process.env.LOGS_DIR = logs;
  const [y, m] = month.split("-");
  const mon = "JanFebMarAprMayJunJulAugSepOctNovDec".slice((Number(m) - 1) * 3, Number(m) * 3);
  const line = (
    path: string,
    status = 200,
    seconds = 0,
    method = "GET",
    date = `01/${mon}/${y}`,
    { ip = "10.0.0.1", time = "12:00:00" } = {},
  ) =>
    `${ip} - - [${date}:${time} -0800] "${method} ${path} HTTP/1.1" ${status} 1000 "-" "Mozilla/5.0 (X)" ${seconds}`;
  const day = `02/${mon}/${y}`;
  await writeFile(
    join(logs, "access.log"),
    [
      line("/archive/night-2026-11-14.mp3"), // reaches both tracks (30 minutes' allowance)
      line("/archive/odd-2026-11-15.mp3", 200, 7200), // reaches 9000 s: Track A and B
      line("/archive/odd-2026-11-15.mp3", 416),
      line("/archive/odd-2026-11-15.mp3", 405, 0, "HEAD"),
      line("/stream", 200, 3600),
      // Left on the 1st after 21 hours: started last month, so not counted.
      line("/archive/odd-2026-11-15.mp3", 200, 21 * 3600, "GET", undefined, { ip: "10.0.0.2" }),
      // One play in three requests: a probe (bytes 0-1), an hour, and after a
      // blip 100 s later, resumed by range for 3500 s: 7200 s in all (Track A and B).
      line("/archive/odd-2026-11-15.mp3", 206, 0, "GET", day, { ip: "10.0.0.3", time: "09:00:00" }),
      line("/archive/odd-2026-11-15.mp3", 200, 3600, "GET", day, { ip: "10.0.0.3", time: "10:00:00" }),
      line("/archive/odd-2026-11-15.mp3", 206, 3500, "GET", day, { ip: "10.0.0.3", time: "11:00:00" }),
      // The same listener again an hour later: its own play (Track A).
      line("/archive/odd-2026-11-15.mp3", 200, 60, "GET", day, { ip: "10.0.0.3", time: "12:01:00" }),
      line("/archive/night-2026-11-14.mp3", 200, 0, "GET", "01/Jan/2001"),
    ].join("\n") + "\n",
  );
  await writeFile(join(logs, "error.log"), line("/archive/night-2026-11-14.mp3") + "\n");
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
    expect(off).toMatch(/Fixture Default, 24\/7: <a class="url" href="\/stream\/default"/);
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

describe("archive", () => {
  test("a show's page lists its blocks up under two weeks, newest ARCHIVE_KEEP first, numbered by day", async () => {
    const rows = async (slug: string) =>
      [
        ...(await (await page(`/${slug}`)).text()).matchAll(
          /data-play="(\/archive\/[^"]+)" data-title="([^"]+)"/g,
        ),
      ].map((m) => [m[1], m[2]]);
    // Numbered from each show's first day with a block (or a sidecar of one).
    expect(await rows("default")).toEqual([["/archive/default-2026-11-14.mp3", "Fixture Default #5"]]);
    expect(await rows("edge")).toEqual([["/archive/edge-2026-11-02.mp3", "Edge Cases #1"]]);
    expect(await rows("night")).toEqual([
      ["/archive/night-2026-11-14.mp3", "Fixture Night #3"],
      ["/archive/night-2026-11-13.mp3", "Fixture Night #2"],
    ]);
    expect(await rows("odd")).toEqual([["/archive/odd-2026-11-15.mp3", "Odd Characters #1"]]);
    const night = await (await page("/night")).text();
    expect(night).toContain("Sat, Nov 14");
    expect(night).toContain("5 h 1 min");
  });

  test("has no page of its own, and isn't in the nav", async () => {
    expect((await page("/archive")).status).toBe(404);
    expect(await (await page("/")).text()).not.toContain('href="/archive"');
  });

  test("a block's button plays the show's earlier blocks after it, newest first", async () => {
    const then = (html: string) =>
      JSON.parse(
        /data-play="\/archive\/night-2026-11-14\.mp3"[^>]*data-then="([^"]+)"/
          .exec(html)![1]!
          .replaceAll("&quot;", '"'),
      ) as unknown;
    const earlier = [{ src: "/archive/night-2026-11-13.mp3", title: "Fixture Night #2" }];
    const show = await (await page("/night")).text();
    expect(then(show)).toEqual(earlier);
    // The last has nothing after it: the player goes back to live.
    expect(show).not.toMatch(/data-play="\/archive\/night-2026-11-13\.mp3"[^>]*data-then/);
    // The home page's latest episode goes on the same way.
    expect(then(await (await page("/")).text())).toEqual(earlier);
  });

  test("offers no downloads and names no tracks", async () => {
    const html = await (await page("/odd")).text();
    expect(html).not.toMatch(/href="[^"]*\.mp3"/);
    expect(html).not.toContain("download");
    expect(html).not.toContain("<audio");
    for (const track of ["Midnight", "Second Wind", "Track A"]) expect(html).not.toContain(track);
  });

  test("a block's now.json has only the track playing at t, with title, artist and album", async () => {
    const at = async (t: string) => (await page(`/archive/night-2026-11-14/now.json?t=${t}`)).json();
    // With when it ends (the next track's offset), none for the last.
    expect(await at("0")).toEqual({
      track: "Midnight",
      artist: "Gamma",
      album: "Album",
      cover: "",
      until: 10.2,
    });
    expect(await at("10")).toMatchObject({ track: "Midnight", until: 10.2 });
    expect(await at("11")).toEqual({
      track: "Second Wind",
      artist: "Beta & Band",
      album: "Album",
      cover: "/covers/default/Beta%20&%20Band-%20Second%20Wind.jpg",
    });
    for (const t of ["-1", "x", ""])
      expect((await page(`/archive/night-2026-11-14/now.json?t=${t}`)).status).toBe(400);
    // Not for a block that can't be played.
    for (const name of ["long-2026-11-15", "nope-2026-11-14", "night-2026-11-10"])
      expect((await page(`/archive/${name}/now.json?t=0`)).status, name).toBe(404);
    expect((await req("/archive/night-2026-11-14/now.json?t=0")).status).toBe(401);
  });

  test("the home page lists each show's latest episode, newest first", async () => {
    const html = await (await page("/")).text();
    const list = html.slice(html.indexOf('id="episodes"'), html.indexOf('id="history"'));
    expect(list).toContain("Latest episodes");
    const plays = [...list.matchAll(/data-play="(\/archive\/[^"]+)" data-title="([^"]+)"/g)].map((m) => [
      m[1],
      m[2],
    ]);
    // One a show (the on-air show's too), newest first; none for quiet (nothing archived).
    expect(plays).toEqual([
      ["/archive/odd-2026-11-15.mp3", "Odd Characters #1"],
      ["/archive/default-2026-11-14.mp3", "Fixture Default #5"],
      ["/archive/night-2026-11-14.mp3", "Fixture Night #3"],
      ["/archive/edge-2026-11-02.mp3", "Edge Cases #1"],
    ]);
    expect(list).toContain('href="/night"');
    expect(list).toContain("A one-track night show.");
    // No list of shows: the latest episodes stand for them.
    expect(html).not.toContain('id="schedule"');
    expect(html).not.toContain("Track A");
  });

  test("a show's page plays its recent archived shows, newest first", async () => {
    const html = await (await page("/night")).text();
    const plays = [...html.matchAll(/data-play="(\/archive\/[^"]+)"/g)].map((m) => m[1]);
    expect(plays).toEqual(["/archive/night-2026-11-14.mp3", "/archive/night-2026-11-13.mp3"]);
    expect(html).toContain("Past episodes");
    expect(await (await page("/quiet")).text()).not.toContain("Past episodes");
  });

  test("while a show waits for the last one's track to end, its page says it starts after this track", async () => {
    // Night is on air (the newest play); whichever show's hours it is now is due.
    const due = showAt(await getShows(), new Date());
    if (!due || due.slug === "night") return;
    expect(await (await page(`/${due.slug}`)).text()).toContain("Starting after this track.");
  });

  test("needs the site password, like every page", async () => {
    expect((await req("/archive/night-2026-11-14/now.json?t=0")).status).toBe(401);
  });
});

describe("about", () => {
  test("is linked from the site", async () => {
    expect(await (await page("/")).text()).toContain('href="/about"');
    expect((await page("/about")).status).toBe(200);
    // Browsers that cached /about's old 301 to /manifesto still get the page.
    expect(await (await page("/manifesto")).text()).toContain('class="page page-about"');
    expect(await (await page("/about")).text()).toContain('href="https://github.com/alexkroman/radio"');
  });

  test("links each statute the station plays under, and answers questions about them", async () => {
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
    expect(html).toContain("Every show, kept so you can hear it again");
    expect(html).toContain("<h3>Why does a show&#39;s page list what has played on air");
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

  test("the SoundExchange report counts each live play's listeners (at least 1 on the station) and each track archive plays reached", async () => {
    const res = await page(`/reports/${month}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="MAZESRADIO01/);
    const rows = (await res.text()).trim().split("\n");
    expect(rows[0]).toMatch(/^\^NAME_OF_SERVICE\^\|/);
    expect(rows.slice(1)).toEqual([
      "^MAZES RADIO^|^A^|^GAMMA^|^MIDNIGHT^|^US1234567890^|^ALBUM^|^LABEL^|7",
      "^MAZES RADIO^|^A^|^ALPHA ARTIST^|^FIRST LIGHT^|^US1234567890^|^ALBUM^|^LABEL^|3",
      "^MAZES RADIO^|^A^|^ODD ONE^|^TRACK A^|^^|^^|^^|3",
      "^MAZES RADIO^|^A^|^BETA & BAND^|^SECOND WIND^|^US1234567890^|^ALBUM^|^LABEL^|2",
      "^MAZES RADIO^|^A^|^ODD ONE^|^TRACK B^|^^|^^|^^|2",
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
