// The sound recording performance complement (17 U.S.C. 114(j)(13)), which
// radio.liq enforces across the station. test/compose.yml shrinks its three
// hours to COMPLEMENT_WINDOW (30 s). The complement show is six 8 s tracks
// by one artist, four from one album: left alone it would break every limit,
// so it has to wait out the window. Every play in the run is checked in
// test/hunt.spec.ts, last.
import { expect, test } from "@playwright/test";
import { complementViolations } from "../app/complement.ts";
import { COMPLEMENT_WINDOW as WINDOW, loggedPlays, onAir } from "./helpers.ts";

test("a show with one artist plays no more than the complement allows, then waits", async () => {
  const before = (await loggedPlays()).length;
  await onAir("complement");
  // Long enough for the show to hit every limit and come back at least once.
  await new Promise((r) => setTimeout(r, 75_000));
  const plays = (await loggedPlays()).slice(before);
  const solo = plays.filter((p) => p.show === "complement");
  expect(solo.length).toBeGreaterThanOrEqual(3);
  expect(complementViolations(plays, WINDOW)).toEqual([]);
  // It did have to wait: never 4 by Solo in any window.
  for (const p of solo)
    expect(solo.filter((q) => q.time > p.time - WINDOW && q.time <= p.time).length).toBeLessThanOrEqual(4);
  // And it came back after waiting.
  const gaps = solo.slice(1).map((p, i) => p.time - solo[i]!.time);
  expect(Math.max(...gaps)).toBeGreaterThanOrEqual(12);
});
