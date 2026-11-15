// Archive plays, for the SoundExchange reports: Icecast logs each request for
// an archive block (GET /archive/<show>-<YYYY-MM-DD>.mp3, answered 200) in
// its access log (/logs/access.log*, kept when rotated) with how long the
// listener was connected. Each play performs every track in the block's
// sidecar that it reached: those starting by the time it disconnected, plus
// ALLOWANCE for audio a player had fetched ahead of what it played (counting
// a track that may not have been heard, rather than miss one that was).
// scripts/archive-plays.sh counts the same requests per block per day.
import { readdir, readFile, stat } from "node:fs/promises";
import { BLOCK, type BlockTrack, blockTracks } from "./archive.ts";

const LOGS = process.env.LOGS_DIR ?? "/logs";
const ALLOWANCE = 30 * 60;
const MONTHS = "JanFebMarAprMayJunJulAugSepOctNovDec";
// 1.2.3.4 - - [15/Nov/2026:20:47:13 -0800] "GET /archive/x.mp3 HTTP/1.1" 200 bytes "ref" "agent" seconds
const LINE = new RegExp(
  `^\\S+ \\S+ \\S+ \\[(\\d{2})/(\\w{3})/(\\d{4}):[^\\]]+\\] "GET /archive/(${BLOCK})\\.mp3 HTTP/[\\d.]+" 200 \\d+ .* (\\d+)$`,
);

type ArchivePlay = { month: string; block: string; seconds: number };

// The archive plays in the access logs that can hold a month's ("YYYY-MM"):
// those last written since it began.
async function archivePlays(month: string): Promise<ArchivePlay[]> {
  const since = new Date(`${month}-01T00:00:00`).getTime();
  const files = (await readdir(LOGS).catch(() => [] as string[])).filter((f) => f.startsWith("access.log"));
  const texts = await Promise.all(
    files.map(async (f) => {
      const st = await stat(`${LOGS}/${f}`).catch(() => undefined);
      return st && st.mtimeMs >= since ? readFile(`${LOGS}/${f}`, "utf8").catch(() => "") : "";
    }),
  );
  return texts.flatMap((text) =>
    text.split("\n").flatMap((line) => {
      const m = LINE.exec(line);
      if (!m) return [];
      const month = `${m[3]}-${String(MONTHS.indexOf(m[2]!) / 3 + 1).padStart(2, "0")}`;
      return [{ month, block: m[4]!, seconds: Number(m[5]) }];
    }),
  );
}

// The tracks archive plays performed in a month ("YYYY-MM"), once per play.
export async function archivePerformances(month: string): Promise<BlockTrack[]> {
  const plays = (await archivePlays(month)).filter((p) => p.month === month);
  const performed = await Promise.all(
    plays.map(async (p) => (await blockTracks(p.block)).filter((t) => t.offset <= p.seconds + ALLOWANCE)),
  );
  return performed.flat();
}
