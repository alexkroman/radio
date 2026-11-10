// Shared helpers for the end-to-end specs.
import { request as https } from "node:https";
import { type APIRequestContext, request } from "@playwright/test";

export const BASE = process.env.BASE_URL ?? "https://localhost";
export const SITE_PASSWORD = process.env.SITE_PASSWORD ?? "";
export const ADMIN = {
  username: "admin",
  password: process.env.ADMIN_PASSWORD ?? "",
};
export const month = new Date().toISOString().slice(0, 7);

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

// Stay connected to a stream (discarding audio) until the returned function is called.
export function listen(path: string): () => void {
  const req = https(new URL(path, BASE), { rejectUnauthorized: false }, (res) => res.resume());
  req.on("error", () => {});
  req.end();
  return () => req.destroy();
}

export function adminRequest(): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: BASE,
    ignoreHTTPSErrors: true,
    httpCredentials: ADMIN,
  });
}

// Performances counted for a song in this month's report (0 if absent).
export async function performances(admin: APIRequestContext, artist: string, title: string): Promise<number> {
  const text = await (await admin.get(`/admin/report?month=${month}`)).text();
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
        const metaint = Number(res.headers["icy-metaint"]);
        if (!metaint) return reject(new Error(`no icy-metaint (status ${res.statusCode})`));
        let buf = Buffer.alloc(0);
        let skip = metaint;
        res.on("data", (chunk: Buffer) => {
          buf = Buffer.concat([buf, chunk]);
          while (buf.length > skip) {
            const len = buf[skip]! * 16;
            if (buf.length < skip + 1 + len) return;
            const meta = buf.subarray(skip + 1, skip + 1 + len).toString("utf8");
            buf = buf.subarray(skip + 1 + len);
            skip = metaint;
            const title = /StreamTitle='(.*?)';/s.exec(meta)?.[1];
            if (title) {
              req.destroy();
              return resolve(title);
            }
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`no ICY title on ${path}`)));
    req.on("error", reject);
    req.end();
  });
}

export type LoggedPlay = { time: number; show: string; artist: string; title: string; listeners: number };

// Every play logged this month (the e2e container mounts the play log).
export async function loggedPlays(): Promise<LoggedPlay[]> {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(`/plays/${month}.jsonl`, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LoggedPlay);
}
