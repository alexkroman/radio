// The sound recording performance complement (17 U.S.C. 114(j)(13)), a
// condition of the statutory license, checked on a play log: in any three
// hours (`window` seconds), at most 4 tracks by one featured artist, 3 in a
// row, and at most 3 from one album, 2 in a row. radio.liq enforces it when
// it picks tracks; this says where a log breaks it (the tests run it on
// every play). Artists and albums are compared as radio.liq does: artists
// split on ",", "&", "feat.", "x", "with"; albums by title.
type Performance = { time: number; artist: string; album: string };

export const artistsOf = (artist: string) =>
  artist
    .toLowerCase()
    .split(/,|&| feat\.? | ft\.? | x | with /)
    .map((a) => a.trim())
    .filter(Boolean);

const albumOf = (p: Performance) => p.album.trim().toLowerCase();

// What breaks the complement, one line per play that does (empty if nothing).
export function complementViolations(plays: Performance[], window = 3 * 3600): string[] {
  const sorted = [...plays].sort((a, b) => a.time - b.time);
  const problems: string[] = [];
  sorted.forEach((play, i) => {
    // The plays in the window that ends with this one, oldest first.
    const recent = sorted.slice(0, i + 1).filter((p) => p.time > play.time - window);
    const run = (matches: (p: Performance) => boolean) => {
      let n = 0;
      for (let j = recent.length - 1; j >= 0 && matches(recent[j]!); j--) n++;
      return n;
    };
    const at = new Date(play.time * 1000).toISOString();
    for (const artist of artistsOf(play.artist)) {
      const by = (p: Performance) => artistsOf(p.artist).includes(artist);
      const count = recent.filter(by).length;
      if (count > 4) problems.push(`${at}: ${count} tracks by ${artist} in the window (at most 4)`);
      if (run(by) > 3) problems.push(`${at}: ${run(by)} tracks by ${artist} in a row (at most 3)`);
    }
    const album = albumOf(play);
    if (album) {
      const from = (p: Performance) => albumOf(p) === album;
      const count = recent.filter(from).length;
      if (count > 3) problems.push(`${at}: ${count} tracks from ${album} in the window (at most 3)`);
      if (run(from) > 2) problems.push(`${at}: ${run(from)} tracks from ${album} in a row (at most 2)`);
    }
  });
  return problems;
}
