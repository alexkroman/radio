// The schedule (app/schedule.ts) from shows' hours (app/shows.ts parseHours).
import { describe, expect, test } from "vitest";
import { nextSlot, scheduleProblems, scheduled, showAt, upNext } from "./schedule.ts";
import { parseHours, type Show } from "./shows.ts";

const show = (slug: string, hours: unknown): Show => {
  const parsed = parseHours(hours);
  return {
    slug,
    title: slug,
    description: "",
    djs: [],
    hours: parsed,
    badHours: parsed || hours === undefined ? undefined : String(hours),
  };
};
// A schedule like the station's.
const SHOWS = [show("drift", "17-22"), show("frequency", "6-17"), show("gloaming", "22-6")];
const at = (h: number, m = 0) => new Date(2026, 10, 15, h, m);

describe("hours", () => {
  test.each([
    ["6-17", [6, 17]],
    [" 22 - 6 ", [22, 6]],
    ["0-24", [0, 24]],
    ["17-0", [17, 0]],
  ])("%j is %j", (text, hours) => expect(parseHours(text)).toEqual(hours));

  test.each(["", "6", "6-6", "0-0", "24-6", "6-25", "6am-5pm", "6:30-17", "-1-5"])("%j isn't hours", (text) =>
    expect(parseHours(text)).toBeUndefined(),
  );

  test("must be a string", () => {
    expect(parseHours(6)).toBeUndefined();
    expect(parseHours(undefined)).toBeUndefined();
  });
});

describe("the schedule", () => {
  test("of the station covers every hour once", () => {
    expect(scheduleProblems(SHOWS)).toEqual([]);
    expect(scheduleProblems([show("all-day", "0-24")])).toEqual([]);
  });

  test("with a gap is an error, a range at a time", () => {
    expect(scheduleProblems([show("drift", "17-22"), show("frequency", "6-16")])).toEqual([
      "00:00-06:00: no show on air",
      "16:00-17:00: no show on air",
      "22:00-24:00: no show on air",
    ]);
  });

  test("with an overlap is an error", () => {
    expect(scheduleProblems([...SHOWS, show("extra", "16-18")])).toEqual([
      "16:00-17:00: more than one show on air (frequency, extra)",
      "17:00-18:00: more than one show on air (drift, extra)",
    ]);
  });

  test("with a show without hours, or bad ones, is an error", () => {
    expect(scheduleProblems([...SHOWS, show("none", undefined), show("bad", "5pm-10pm")])).toEqual([
      "none: no hours (e.g. hours: 6-17)",
      'bad: "hours: 5pm-10pm" isn\'t <start>-<end> in whole hours from 0 to 24 (e.g. hours: 6-17)',
    ]);
    expect(scheduleProblems([])).toEqual(["00:00-24:00: no show on air"]);
  });

  test("is in the order the shows are on from now, the one on now first", () => {
    const order = (h: number) => scheduled(SHOWS, at(h)).map((s) => s.slug);
    expect(order(12)).toEqual(["frequency", "drift", "gloaming"]);
    expect(order(18)).toEqual(["drift", "gloaming", "frequency"]);
    expect(order(3)).toEqual(["gloaming", "frequency", "drift"]);
  });

  test.each([
    [5, "gloaming"],
    [6, "frequency"],
    [16, "frequency"],
    [17, "drift"],
    [22, "gloaming"],
    [0, "gloaming"],
  ])("at %i:00 has %s on", (h, slug) => expect(showAt(SHOWS, at(h, 30))?.slug).toBe(slug));

  test("has what's on next, and when", () => {
    expect(upNext(SHOWS, at(16, 59))).toEqual({ show: SHOWS[0], start: at(17) });
    expect(upNext(SHOWS, at(23))).toEqual({ show: SHOWS[1], start: new Date(2026, 10, 16, 6) });
    expect(upNext([show("all-day", "0-24")], at(12))).toBeUndefined();
  });

  test("has a show's slot: now while it's on, else the next", () => {
    const [drift, , gloaming] = SHOWS;
    expect(nextSlot(drift!, at(12))).toEqual({ start: at(17), end: at(22) });
    expect(nextSlot(drift!, at(18))).toEqual({ start: at(17), end: at(22) });
    expect(nextSlot(drift!, at(22))).toEqual({ start: at(17 + 24), end: at(22 + 24) });
    // One past midnight: from last night while it's on.
    expect(nextSlot(gloaming!, at(3))).toEqual({ start: at(22 - 24), end: at(6) });
    expect(nextSlot(gloaming!, at(12))).toEqual({ start: at(22), end: at(6 + 24) });
  });
});
