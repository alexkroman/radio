// A listener for test/e2e.sh's deploy checks: plays a show's stream through
// Caddy, as a player does, and logs each pause in the audio over 1 s, the
// longest on SIGTERM, and the stream ending (a dropped listener).
// Run in the e2e container: node test/listen.ts <slug>
import { request } from "node:https";

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const base = process.env.BASE_URL ?? "https://localhost";
let last = Date.now();
let longest = 0;

request(new URL(`/${process.argv[2]}/stream`, base), { rejectUnauthorized: false }, (res) => {
  log(`connected ${res.statusCode}`);
  last = Date.now();
  res.on("data", () => {
    const gap = Date.now() - last;
    if (gap > 1000) log(`gap ${gap} ms`);
    longest = Math.max(longest, gap);
    last = Date.now();
  });
  res.on("end", () => {
    log("ended");
    process.exit(1);
  });
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
