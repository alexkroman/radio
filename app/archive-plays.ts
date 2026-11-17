// Archive plays, for the SoundExchange reports: Icecast logs each request for
// an archive block (GET /archive/<show>-<YYYY-MM-DD>.mp3, answered 200, or
// 206 for a range) in its access log (/logs/access.log*, kept when rotated)
// with how long the listener was connected, timestamped when they left. A
// play can be several requests: a player that drops (a blip, a network
// change) resumes with a range request, and some probe first (Safari asks for
// bytes 0-1). So a listener's (address and user agent) requests for a block
// that overlap or follow within GAP are one play, from the first's start to
// the last's end (the month it started is the one it counts in). The player
// can't seek, so a play is at most that far in. Each play performs every track in the block's
// sidecar that it reached: those starting by the time it disconnected, plus
// ALLOWANCE for audio a player had fetched ahead of what it played (counting
// a track that may not have been heard, rather than miss one that was).
// scripts/archive-plays.sh counts the same requests per block per day.
// Months are the station's (TZ), as for the plays log.
import { readdir, readFile, stat } from "node:fs/promises";
import { BLOCK, type BlockTrack, blockTracks } from "./archive.ts";
import { monthOf } from "./plays.ts";

const LOGS = process.env.LOGS_DIR ?? "/logs";
const ALLOWANCE = 30 * 60;
// The player retries a dropped block for two minutes (client.ts dropped).
const GAP = 120;
const MONTHS = "JanFebMarAprMayJunJulAugSepOctNovDec";
// 1.2.3.4 - - [15/Nov/2026:20:47:13 -0800] "GET /archive/x.mp3 HTTP/1.1" 200 bytes "ref" "agent" seconds
const LINE = new RegExp(
  `^(\\S+) \\S+ \\S+ \\[(\\d{2})/(\\w{3})/(\\d{4}):(\\d{2}:\\d{2}:\\d{2}) ([+-]\\d{2})(\\d{2})\\] "GET /archive/(${BLOCK})\\.mp3 HTTP/[\\d.]+" 20[06] \\d+ ".*" (".*") (\\d+)$`,
);

type ArchivePlay = { month: string; block: string; seconds: number };

// The archive plays in the access logs that can hold a month's ("YYYY-MM"):
// those last written since it began. Each with the month it started in.
async function archivePlays(month: string): Promise<ArchivePlay[]> {
  const since = new Date(`${month}-01T00:00:00`).getTime();
  const files = (await readdir(LOGS).catch(() => [] as string[])).filter((f) => f.startsWith("access.log"));
  const texts = await Promise.all(
    files.map(async (f) => {
      const st = await stat(`${LOGS}/${f}`).catch(() => undefined);
      return st && st.mtimeMs >= since ? readFile(`${LOGS}/${f}`, "utf8").catch(() => "") : "";
    }),
  );
  // Each request: whose (address, agent, block), and when it started and ended.
  const requests = texts.flatMap((text) =>
    text.split("\n").flatMap((line) => {
      const m = LINE.exec(line);
      if (!m) return [];
      const [, ip, d, mon, y, time, tzh, tzm, block, agent, secs] = m;
      const mm = String(MONTHS.indexOf(mon!) / 3 + 1).padStart(2, "0");
      const end = Date.parse(`${y}-${mm}-${d}T${time}${tzh}:${tzm}`) / 1000;
      return [{ who: `${ip} ${agent} ${block}`, block: block!, start: end - Number(secs), end }];
    }),
  );
  requests.sort((a, b) => (a.who < b.who ? -1 : a.who > b.who ? 1 : a.start - b.start));
  const plays: ArchivePlay[] = [];
  let play: { who: string; block: string; start: number; end: number } | undefined;
  const done = () =>
    play &&
    plays.push({
      month: monthOf(new Date(play.start * 1000)),
      block: play.block,
      seconds: play.end - play.start,
    });
  for (const r of requests) {
    if (play && play.who === r.who && r.start <= play.end + GAP) play.end = Math.max(play.end, r.end);
    else {
      done();
      play = { ...r };
    }
  }
  done();
  return plays;
}

// The tracks archive plays performed in a month ("YYYY-MM"), once per play.
export async function archivePerformances(month: string): Promise<BlockTrack[]> {
  const plays = (await archivePlays(month)).filter((p) => p.month === month);
  const performed = await Promise.all(
    plays.map(async (p) => (await blockTracks(p.block)).filter((t) => t.offset <= p.seconds + ALLOWANCE)),
  );
  return performed.flat();
}
