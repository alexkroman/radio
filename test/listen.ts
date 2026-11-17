// A listener for test/e2e.sh's deploy checks, through Caddy, as a player does.
// The live stream (the default) comes at its own pace: log each pause in the
// audio over 1 s. An archive block (a path, /archive/<block>.mp3) is a file
// Icecast sends as fast as it's read, so read it as a player plays it, 256 kbps
// (32,000 bytes a second), and log each time over 1 s it had nothing to give
// when the player needed audio. Either way: the longest on SIGTERM, and the
// response ending (a dropped listener).
// Run in the e2e container: node test/listen.ts [/archive/<block>.mp3]
import { request } from "node:https";

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const base = process.env.BASE_URL ?? "https://localhost";
const path = process.argv[2] ?? "/stream";
const BYTES_A_SECOND = 32_000;
let last = Date.now();
let longest = 0;
const gap = () => {
  const ms = Date.now() - last;
  if (ms > 1000) log(`gap ${ms} ms`);
  longest = Math.max(longest, ms);
  last = Date.now();
};

request(new URL(path, base), { rejectUnauthorized: false }, (res) => {
  log(`connected ${res.statusCode}`);
  last = Date.now();
  res.on("end", () => {
    log("ended");
    process.exit(1);
  });
  if (path === "/stream") return res.on("data", gap);
  // A block: every 100 ms the player wants another 100 ms of audio.
  let owed = 0;
  res.on("readable", () => undefined); // paused mode: read() pulls
  setInterval(() => {
    owed += BYTES_A_SECOND / 10;
    for (let chunk: Buffer | null; owed > 0 && (chunk = res.read() as Buffer | null);) {
      owed -= chunk.length;
      gap();
    }
    // Not starved while it has what the player wants.
    if (owed <= 0) last = Date.now();
  }, 100);
})
  .on("error", (e) => {
    log(`error ${e.message}`);
    process.exit(1);
  })
  .end();

process.on("SIGTERM", () => {
  log(`longest gap ${longest} ms`);
  process.exit(0);
});
