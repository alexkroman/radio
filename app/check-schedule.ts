// Fails (exit 1) unless the shows in shows/ (or SHOWS_DIR) cover every hour of
// the day exactly once, saying what's wrong. radio.liq schedules every
// shows/*.md, so a file the site can't use as a show (a reserved slug such as
// "archive", or a name that isn't lowercase letters, digits and hyphens) is
// an error too. Run by pre-commit (and so CI) on a change to shows/, and by
// scripts/deploy.sh before it syncs anything:
//   node app/check-schedule.ts
import { readdir } from "node:fs/promises";
import { scheduleProblems } from "./schedule.ts";

process.env.SHOWS_DIR ??= "shows";
const { getShows } = await import("./shows.ts");
const shows = await getShows();
const slugs = new Set(shows.map((s) => `${s.slug}.md`));
const problems = [
  ...(await readdir(process.env.SHOWS_DIR))
    .filter((f) => f.endsWith(".md") && !slugs.has(f))
    .map(
      (f) =>
        `${f}: not a show the site can list (a reserved name, or not lowercase letters, digits and hyphens)`,
    ),
  ...scheduleProblems(shows),
];
if (problems.length) {
  console.error(`The shows' hours must cover all 24 hours, each exactly once:`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
