// The performance complement check (app/complement.ts).
import { describe, expect, test } from "vitest";
import { artistsOf, complementViolations } from "./complement.ts";

const play = (minute: number, artist: string, album = "") => ({ time: minute * 60, artist, album });

describe("the performance complement", () => {
  test("splits featured artists as radio.liq does", () => {
    expect(artistsOf("Ana & Ben feat. Cy, Dee x Eve with Fay")).toEqual([
      "ana",
      "ben",
      "cy",
      "dee",
      "eve",
      "fay",
    ]);
    expect(artistsOf("")).toEqual([]);
  });

  test("allows 4 tracks by an artist in three hours, 3 in a row", () => {
    const plays = [play(0, "A"), play(5, "A"), play(10, "A"), play(15, "B"), play(20, "A")];
    expect(complementViolations(plays)).toEqual([]);
  });

  test("refuses a fifth track by an artist in three hours", () => {
    const plays = [0, 10, 20, 30, 40].flatMap((m) => [play(m, "A"), play(m + 5, m < 40 ? "B" : "C")]);
    expect(complementViolations(plays)).toEqual([
      "1970-01-01T00:40:00.000Z: 5 tracks by a in the window (at most 4)",
    ]);
    // Three hours later it's fine again.
    expect(complementViolations([...plays.slice(0, 8), play(200, "A"), play(201, "B")])).toEqual([]);
  });

  test("refuses a fourth track in a row by an artist, featured or not", () => {
    const plays = [play(0, "A"), play(5, "A & B"), play(10, "C feat. A"), play(15, "A")];
    expect(complementViolations(plays)).toEqual([
      "1970-01-01T00:15:00.000Z: 4 tracks by a in a row (at most 3)",
    ]);
  });

  test("allows 3 tracks from an album, 2 in a row, and limits albums by title", () => {
    expect(
      complementViolations([play(0, "A", "X"), play(5, "B", "X"), play(10, "C"), play(15, "D", "x")]),
    ).toEqual([]);
    expect(complementViolations([play(0, "A", "X"), play(5, "B", "X"), play(10, "C", "X")])).toEqual([
      "1970-01-01T00:10:00.000Z: 3 tracks from x in a row (at most 2)",
    ]);
    const four = [
      play(0, "A", "X"),
      play(5, "B"),
      play(10, "C", "X"),
      play(15, "D"),
      play(20, "E", "X"),
      play(25, "F"),
      play(30, "G", "X"),
    ];
    expect(complementViolations(four)).toEqual([
      "1970-01-01T00:30:00.000Z: 4 tracks from x in the window (at most 3)",
    ]);
  });

  test("ignores tracks without an album, and takes a shorter window", () => {
    expect(
      complementViolations([play(0, "A"), play(1, "B"), play(2, "C")].map((p) => ({ ...p, album: "" }))),
    ).toEqual([]);
    const plays = [play(0, "A"), play(1, "A"), play(2, "A"), play(3, "A")];
    expect(complementViolations(plays, 60)).toEqual([]);
    expect(complementViolations(plays, 600)).toEqual([
      "1970-01-01T00:03:00.000Z: 4 tracks by a in a row (at most 3)",
    ]);
  });
});
