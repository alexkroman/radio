// A listener for test/e2e.sh's deploy checks, through Caddy, as a player does:
// on the station's stream (the default) or a show's channel (/stream/<show>),
// which come at their own pace. Log each pause in the audio over 1 s, the
// longest on SIGTERM, and the response ending (a dropped listener).
// Run in the e2e container: node test/listen.ts [/stream/<show>]
import { request } from "node:https";

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const base = process.env.BASE_URL ?? "https://localhost";
const path = process.argv[2] ?? "/stream";
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
  res.on("data", gap);
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
