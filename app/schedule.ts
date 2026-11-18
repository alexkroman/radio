// The station's schedule: each show's hours (app/shows.ts) on the one stream,
// which radio.liq follows. They must cover every hour of the day exactly once:
// scheduleProblems says where they don't, for app/check-schedule.ts (which
// stops a commit or a deploy) and the unit tests.
import type { Hours, Show } from "./shows.ts";

const HOURS = Array.from({ length: 24 }, (_, h) => h);

// Whether hour h (0-23) is within hours.
const covers = ([start, end]: Hours, h: number) =>
  start < end ? h >= start && h < end : h >= start || h < end;

// A show's length in hours.
const length = ([start, end]: Hours) => (end - start + 24) % 24 || 24;

const clock = (h: number) => `${String(h).padStart(2, "0")}:00`;

// What's wrong with the schedule, one line each; empty when every hour has
// exactly one show.
export function scheduleProblems(shows: Show[]): string[] {
  const problems: string[] = [];
  for (const s of shows) {
    if (s.badHours !== undefined)
      problems.push(
        `${s.slug}: "hours: ${s.badHours}" isn't <start>-<end> in whole hours from 0 to 24 (e.g. hours: 6-17)`,
      );
    else if (!s.hours) problems.push(`${s.slug}: no hours (e.g. hours: 6-17)`);
  }
  const at = HOURS.map((h) => shows.filter((s) => s.hours && covers(s.hours, h)).map((s) => s.slug));
  // Consecutive hours with the same problem as one range.
  const ranges = (bad: (slugs: string[]) => boolean) => {
    const found: { from: number; to: number; slugs: string[] }[] = [];
    for (const h of HOURS) {
      if (!bad(at[h]!)) continue;
      const last = found.at(-1);
      if (last && last.to === h && last.slugs.join() === at[h]!.join()) last.to = h + 1;
      else found.push({ from: h, to: h + 1, slugs: at[h]! });
    }
    return found;
  };
  for (const r of ranges((s) => s.length === 0))
    problems.push(`${clock(r.from)}-${clock(r.to)}: no show on air`);
  for (const r of ranges((s) => s.length > 1))
    problems.push(`${clock(r.from)}-${clock(r.to)}: more than one show on air (${r.slugs.join(", ")})`);
  return problems;
}

// The scheduled shows in the order they're on from now: the one on now
// first, then what's up next.
export const scheduled = (shows: Show[], now: Date) =>
  shows
    .filter((s) => s.hours)
    .map((s) => ({ s, start: nextSlot(s, now)!.start.getTime() }))
    .sort((a, b) => a.start - b.start)
    .map(({ s }) => s);

// The show scheduled at a time (the first by slug, if more than one).
export const showAt = (shows: Show[], at: Date) =>
  shows.find((s) => s.hours && covers(s.hours, at.getHours()));

// When a show is next on the air (now, if it's on): its start and end.
export function nextSlot(show: Show, now: Date): { start: Date; end: Date } | undefined {
  if (!show.hours) return undefined;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), show.hours[0]);
  // The slot that started yesterday, if it's still on (one past midnight).
  if (start > now) start.setDate(start.getDate() - 1);
  const end = new Date(start);
  end.setHours(start.getHours() + length(show.hours));
  if (end <= now) {
    start.setDate(start.getDate() + 1);
    end.setDate(end.getDate() + 1);
  }
  return { start, end };
}

// The show on after the one scheduled now, and when it starts.
export function upNext(shows: Show[], now: Date): { show: Show; start: Date } | undefined {
  const current = showAt(shows, now);
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours());
  for (let i = 1; i <= 24; i++) {
    at.setHours(at.getHours() + 1);
    const show = showAt(shows, at);
    if (show && show !== current) return { show, start: new Date(at) };
  }
  return undefined;
}
