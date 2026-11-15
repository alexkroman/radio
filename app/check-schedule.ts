// Fails (exit 1) unless the shows in shows/ (or SHOWS_DIR) cover every hour of
// the day exactly once, saying what's wrong. Run by pre-commit (and so CI) on
// a change to shows/, and by scripts/deploy.sh before it syncs anything:
//   node app/check-schedule.ts
import { scheduleProblems } from "./schedule.ts";

process.env.SHOWS_DIR ??= "shows";
const { getShows } = await import("./shows.ts");
const problems = scheduleProblems(await getShows());
if (problems.length) {
  console.error(`The shows' hours must cover all 24 hours, each exactly once:`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
