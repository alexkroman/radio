// Shared helpers for the end-to-end specs.
import { readFile } from "node:fs/promises";
import { request as https } from "node:https";
import { type APIRequestContext, expect, type Page } from "@playwright/test";
import { IcecastMetadataReader } from "icecast-metadata-js";
import { parseJsonl, type Play } from "../app/plays.ts";

export const BASE = process.env.BASE_URL ?? "https://localhost";
export const SITE_PASSWORD = process.env.SITE_PASSWORD ?? "";
// For test.use(): a browser and `request` with no login cookie.
export const LOGGED_OUT = { storageState: { cookies: [], origins: [] } };
export const month = new Date().toISOString().slice(0, 7);
// test/compose.yml's COMPLEMENT_WINDOW: the performance complement's three hours, in seconds.
export const COMPLEMENT_WINDOW = 30;

// Status, type and first ~16 KB of a (never-ending) stream.
export function streamHead(path: string): Promise<{ status?: number; type?: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const req = https(new URL(path, BASE), { rejectUnauthorized: false, timeout: 30_000 }, (res) => {
      const done = (bytes: number) => {
        resolve({
          status: res.statusCode,
          type: res.headers["content-type"],
          bytes,
        });
        req.destroy();
      };
      let bytes = 0;
      if (res.statusCode !== 200) return done(0);
      res.on("data", (chunk: Buffer) => (bytes += chunk.length) > 16_384 && done(bytes));
    });
    req.on("timeout", () => req.destroy(new Error(`timeout reading ${path}`)));
    req.on("error", reject);
    req.end();
  });
}

// The first `size` bytes of a response (a stream or a file).
export function firstBytes(path: string, size = 65_536): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let got = 0;
    const req = https(new URL(path, BASE), { rejectUnauthorized: false, timeout: 30_000 }, (res) => {
      res.on("data", (c: Buffer) => {
        chunks.push(c);
        if ((got += c.length) >= size) {
          req.destroy();
          resolve(Buffer.concat(chunks).subarray(0, size));
        }
      });
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("timeout", () => req.destroy(new Error(`timeout reading ${path}`)));
    req.on("error", reject);
    req.end();
  });
}

// An MP3's format, from its first frame header (MPEG-1 Layer III) that a
// second header follows where the first frame ends.
const BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const SAMPLE_RATES = [44_100, 48_000, 32_000];
export function mp3Format(bytes: Buffer): { kbps: number; sampleRate: number; channels: number } | undefined {
  const header = (i: number) => {
    if (i + 4 > bytes.length || bytes[i] !== 0xff || (bytes[i + 1]! & 0xfe) !== 0xfa) return undefined;
    const kbps = BITRATES[bytes[i + 2]! >> 4];
    const sampleRate = SAMPLE_RATES[(bytes[i + 2]! >> 2) & 3];
    if (!kbps || !sampleRate) return undefined;
    const length = Math.floor((144_000 * kbps) / sampleRate) + ((bytes[i + 2]! >> 1) & 1);
    return { kbps, sampleRate, channels: bytes[i + 3]! >> 6 === 3 ? 1 : 2, length };
  };
  for (let i = 0; i < bytes.length; i++) {
    const h = header(i);
    if (h && header(i + h.length)) return { kbps: h.kbps, sampleRate: h.sampleRate, channels: h.channels };
  }
  return undefined;
}

// Stay connected to a stream (discarding audio) until the returned function is called.
export function listen(path: string): () => void {
  const req = https(new URL(path, BASE), { rejectUnauthorized: false }, (res) => res.resume());
  req.on("error", () => {});
  req.end();
  return () => req.destroy();
}

// Performances counted for a song in this month's report (0 if absent).
export async function performances(
  request: APIRequestContext,
  artist: string,
  title: string,
): Promise<number> {
  const text = await (await request.get(`/reports/${month}`)).text();
  const row = text.split("\n").find((l) => l.startsWith(`^MAZES RADIO^|^A^|^${artist}^|^${title}^|`));
  return row ? Number(row.split("|").at(-1)) : 0;
}

// The first StreamTitle in a stream's in-band (ICY) metadata, as players see it.
export function icyTitle(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https(
      new URL(path, BASE),
      { rejectUnauthorized: false, timeout: 30_000, headers: { "Icy-MetaData": "1" } },
      (res) => {
        const icyMetaInt = Number(res.headers["icy-metaint"]);
        if (!icyMetaInt) return reject(new Error(`no icy-metaint (status ${res.statusCode})`));
        const reader = new IcecastMetadataReader({
          icyMetaInt,
          onMetadata: ({ metadata }) => {
            if (!metadata.StreamTitle) return;
            req.destroy();
            resolve(metadata.StreamTitle);
          },
        });
        res.on("data", (chunk: Buffer) => reader.readAll(chunk));
      },
    );
    req.on("timeout", () => req.destroy(new Error(`no ICY title on ${path}`)));
    req.on("error", reject);
    req.end();
  });
}

// Every play logged this month (the e2e container mounts the play log), on
// the station or, given a show, on its own channel (/stream/<show>),
// skipping a line that is still being written.
export async function loggedPlays(channel?: string): Promise<Play[]> {
  const text = await readFile(`/plays/${month}${channel ? `.${channel}` : ""}.jsonl`, "utf8").catch(() => "");
  return parseJsonl<Play>(text);
}

// Put a show on air (radio.liq's onair, which test/compose.yml enables), and
// wait for its first play: the track playing finishes first.
export async function onAir(show: string, { wait = true } = {}) {
  const res = await fetch("http://liquidsoap:7000/onair", { method: "POST", body: show });
  if (!res.ok) throw new Error(`onair ${show}: ${res.status}`);
  if (wait) await expect.poll(async () => (await loggedPlays()).at(-1)?.show, { timeout: 90_000 }).toBe(show);
}

// Reload until the now playing track matches (the show may not have logged it yet).
export async function waitForTrack(page: Page, text: string | RegExp) {
  await expect(async () => {
    await page.reload();
    await expect(page.locator("#np .np-track")).toHaveText(text, { timeout: 1000 });
  }).toPass();
}

// The site's audio element (app/client.ts exposes it): the stream it plays,
// and whether it is playing (unpaused, with audio buffered).
export const player = (page: Page) =>
  page.evaluate(() => {
    const a = (window as unknown as { audio: HTMLAudioElement }).audio;
    return { src: a.getAttribute("src"), playing: !a.paused && a.readyState >= 3 };
  });

export const playerState = async (page: Page) => ((await player(page)).playing ? "playing" : "stopped");
