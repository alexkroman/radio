# Radio

A small internet radio station: stock open-source services plus one small TypeScript app.

- **Liquidsoap** plays one 24/7 stream, each show at its hours of the day, on shuffle with automatic cue points, loudness levelling and crossfades, appends every play (tags and listener count) to a monthly log, `plays/YYYY-MM.jsonl`, and records each show block to `archive/`.
- **Icecast** serves the stream, with track titles (UTF-8) in the stream for players like VLC, and the archive's recorded blocks.
- **`app/`** ([Hono](https://hono.dev)) serves what's on air, the schedule, the show pages and the SoundExchange reports (from the play log). Its browser code (htmx, fonts) is bundled from npm, so nothing loads from a CDN, and plays the stream in a plain `<audio>` element.
- **Caddy** provides HTTPS and is the only public entry point.
- **Docker** restarts any service that crashes.

## Setup

Requires Docker.

```sh
cp .env.example .env              # then replace every change-me value, e.g. with: openssl rand -hex 16, and set TZ
mkdir -p music/<slug>             # one directory per show (e.g. music/myshow)
cp ~/some/music/*.mp3 music/<slug>/
# shows/<slug>.md defines each show (see Shows below)
docker compose up -d --build
```

Open <https://localhost/>. On localhost your browser warns about the certificate the first time; for a public station, add `DOMAIN=radio.example.com` to `.env` and Caddy gets a real certificate. See [`.env.example`](.env.example) for all settings.

## Everyday commands

| Command                             | What it does                                         |
| ----------------------------------- | ---------------------------------------------------- |
| `docker compose up -d --build`      | Start (or apply config and code changes)             |
| `docker compose down`               | Stop (`down -v` also deletes stats and history!)     |
| `docker compose logs -f`            | Follow logs (Ctrl-C stops watching, not the station) |
| `docker compose ps`                 | Show which services are running                      |
| `docker compose restart caddy`      | Pick up edits to `caddy/Caddyfile`                   |
| `docker compose restart liquidsoap` | Pick up edits to `radio.liq` (listeners stay on)     |

Add or remove files in `music/<show>/` any time; they're picked up without a restart. Anything ffmpeg can decode works.

A track that goes silent for 10 seconds (a hidden track after minutes of silence, a file that decodes to nothing) is skipped. A show with nothing to play streams silence while it's on, so listeners stay connected.

## Shows

The station is one 24/7 stream at `/stream`. Each `shows/<slug>.md` is a show: it plays `music/<slug>/` on shuffle during its hours, and has a page at `/<slug>`. Slugs are lowercase letters, digits and hyphens. The front matter sets the title and hours; the body is the description shown on the page:

```md
---
title: My Show
hours: 6-17
---

A description shown on the show's page.
```

### Schedule

`hours: <start>-<end>` is when a show is on air every day: whole hours on a 24-hour clock in the station's time zone (`TZ` in `.env`), the end not included. `22-6` runs past midnight, `0-24` is all day. When a show's hours start, the track playing finishes first, so a show can start a few minutes late. A show that's off air picks up where it left off next time.

Together the shows must cover all 24 hours, each hour exactly once. `node app/check-schedule.ts` says which hours have no show or more than one, and which shows have no hours or bad ones. pre-commit (and so CI) runs it when `shows/` changes, and `scripts/deploy.sh` won't deploy until it passes. If a bad schedule reaches the server anyway, Liquidsoap logs an error for each problem and keeps going: an hour with no show plays silence, and an hour with two plays the first by slug.

Hours edits apply within a minute, without a restart.

### DJs

List a show's DJs in its front matter. Each DJ gets a page at `/djs/<name-slug>` (e.g. `/djs/ana-ruiz`), linked from "with …" under the show's name; a DJ on several shows has one page listing them all. A bare name is enough; the other fields are optional and can be written on any one of the DJ's shows:

```md
---
title: My Show
djs:
  - name: Ana Ruiz
    tagline: Brooklyn, NY # one line under the name
    photo: djs/ana-ruiz.jpg # an image file in shows/ (jpg, png, webp, avif or gif)
    bio: Two or three sentences, in Markdown.
    links: # the "Elsewhere" list; http(s) links only
      Instagram: https://instagram.com/anaruiz
      Mixcloud: https://www.mixcloud.com/anaruiz/
  - Ben Cho
---
```

A DJ's page address comes from their name: lowercased, accents dropped, anything else between letters and digits turned into `-` (`Zoë Ñandú` → `/djs/zoe-nandu`). A name without Latin letters or digits makes no address, and the DJ is left out.

A show with one DJ lists just them, on one line if you like:

```md
---
title: My Show
djs: [Ana Ruiz]
---
```

The show files are in the repo. Adding or removing a show needs a Liquidsoap restart, which `scripts/reconcile.sh` does (a deploy runs it; no listener is dropped); editing a title, description or hours shows up without one.

## Archive

Liquidsoap records the program as broadcast (the final mix, after the limiter) at the stream's 256 kbps, one MP3 per show block: `archive/recording/<show>-<YYYY-MM-DD>.mp3` while it records, the date being the day the block started. A block follows the clock, not the songs: its show's hours plus a minute of what follows (`ARCHIVE_TAIL`), so Drift's runs 17:00–22:01 and a restart's few seconds don't take it under five hours. When it ends it moves to `archive/blocks/` if it's at least five hours long (an archived program under the statutory license must be), else to `archive/short/`, which nothing serves. A Liquidsoap restart mid-block carries on in the same file, and an error writing it (a full disk) is retried every 10 s without touching the stream.

Each block has a sidecar, `archive/tracks/<show>-<YYYY-MM-DD>.jsonl`: a line per track with its offset in the file and its tags. The player uses it to show each track's title, artist and album while it plays, never before (the block's `now.json?t=<seconds>` answers with the one track playing then), and the reports use it to count archive plays per track. Sidecars are kept after their blocks; deploys back them up to `backup/archive/tracks/`.

`/archive` lists each show's blocks, newest first, with date and length, and the home page has the latest. They play in the site's player from the beginning, then the show's block before, with no seeking and no download. Icecast serves the files at `/archive/<show>-<date>.mp3` (Caddy passes only GET there, drops `Range`, and hides the length, so players can't seek), each play its own connection.

Retention: the `archive-prune` service runs `scripts/prune-archive.sh` at start and every hour (so nightly too). It deletes blocks before they've been up two weeks (at 14 days less an hour), then all but the newest `ARCHIVE_KEEP` (`.env`, default 1) of each show, and anything in `archive/short/`. An hour is ~115 MB, so the default keeps ~2.8 GB of finished blocks, plus up to ~1.3 GB being recorded.

Plays: each request for a block is a line in Icecast's `logs/access.log` (kept when rotated, as `access.log.<date>`; deploys back them up to `backup/logs/`), apart from `/stream`'s. The SoundExchange reports count each archive play once for every track it reached (`app/archive-plays.ts`), and `scripts/archive-plays.sh` prints plays and hours connected per block per day:

```sh
scripts/archive-plays.sh                    # logs/access.log* on the server
scripts/archive-plays.sh backup/logs/access.log*
```

## The statutory license

The station plays music under the statutory license for noncommercial webcasting (17 U.S.C. § 114(d)(2), § 112(e); 37 C.F.R. Parts 380 and 370). `/about` links each provision and answers listeners' questions about them. What the code does to keep its conditions:

- **Performance complement** (§ 114(j)(13)): `radio.liq` refuses any track that would make more than 4 by one artist (3 in a row) or 3 from one album (2 in a row) in three hours, across the station. A show with nothing else plays silence until it can. `app/complement.ts` checks a play log the same way (the e2e suite checks every play).
- **No advance announcements** (§ 114(d)(2)(C)(ii)): the schedule names shows, never tracks; archive blocks list no tracks.
- **Archived programs** (§ 114(d)(2)(C)(iii)): at least five hours, down before two weeks (above).
- **No copying** (§ 114(d)(2)(C)(vi)): no downloads, no seeking.
- **Track identification** (§ 114(d)(2)(C)(ix)): title, artist and album while each track plays, on the site, the lock screen and the stream's ICY title (`Artist - Title (Album)`).
- **Reports of use** (37 C.F.R. Part 370): `/reports`, live and archive performances.

Not in code: filing the Notice of Use with the Copyright Office, paying SoundExchange, and anything a lawyer would add.

## Where things are

| URL                          | What's there                                  |
| ---------------------------- | --------------------------------------------- |
| `https://localhost/`         | What's on air, the player, up next, schedule  |
| `https://localhost/<slug>`   | A show's hours, now playing (on air), history |
| `https://localhost/stream`   | The stream for apps and VLC                   |
| `https://localhost/archive`  | Recorded show blocks, newest first            |
| `https://localhost/djs/<dj>` | A DJ's profile and shows                      |
| `https://localhost/reports`  | Monthly SoundExchange reports                 |

Set `SITE_PASSWORD` in `.env` to put the show pages behind a login form; the stream stays public so apps can play it. After 10 wrong passwords from one address, logins are refused for 15 minutes. Nothing else is public.

## Deploy to OVHcloud (Hillsboro)

`scripts/deploy.sh` puts the station on an OVHcloud Public Cloud server in Hillsboro, Oregon (region `US-WEST-OR-1`). It uses only stock tools: the OpenStack CLI creates the server (once), [`scripts/cloud-init.yml`](scripts/cloud-init.yml) installs Docker from Ubuntu's packages, and rsync + ssh copy the files git tracks (commit or `git add` new ones) plus `.env`, `shows/`, `music/` and `covers/`, then run `docker compose up -d --build`. The station's `logs/` and `plays/` stay on the server and are never overwritten.

```sh
pipx install python-openstackclient   # once
. ./openrc.sh                         # from the OVHcloud control panel: Public Cloud → Users & Roles → download OpenStack RC, region US-WEST-OR-1
scripts/deploy.sh                     # run again after any change to redeploy
scripts/deploy.sh media               # after scripts/import.sh or editing shows: copy just music/, covers/, shows/
```

Both check the schedule first, mirror your `music/`, `covers/` and `shows/` to the server, so files you delete locally go from the server too, and restart Liquidsoap when a show was added or removed, without dropping listeners. Set `IP=<server address>` to run it without the OpenStack CLI or `openrc.sh`.

Every run also copies the server's play log to `backup/plays/` on your computer (it's the only record for SoundExchange reports), so deploy or sync now and then. The server installs security updates by itself and, when one needs it, reboots at 11:00 UTC (3–4 am Pacific); Docker brings the station back up.

Set `DOMAIN` in `.env` and point the domain's DNS A record at the server's address (the IP `scripts/deploy.sh` prints; it stays the same). Only ports 22 and 443 are open. To change the size, set `FLAVOR` (`openstack flavor list`; default `b3-8`).

## Development

Node 22 for the TypeScript (`app/`, `test/`):

```sh
npm ci              # once after cloning
npm run typecheck   # tsc
npm run lint        # eslint
npm run build       # esbuild → dist/ (the Docker image does this too)
```

## End-to-end tests

`npm run e2e` builds the images, starts the real stack (Caddy, Icecast, Liquidsoap, the app) on the fixture shows and music in `test/fixtures/` (the tests put the show they need on air through a hook only the test stack enables), runs the Playwright suites in `test/` from a container inside Caddy's network, and tears everything down. It needs only Docker, uses its own compose project (`radio-e2e`) and throwaway volumes, publishes no ports, and doesn't touch `logs/`, `covers/`, `plays/` or `music/`. Pass Playwright arguments through, e.g. `npm run e2e -- -g "report"`.

## Checks

CI (`.github/workflows/ci.yml`, GitHub Actions) runs `pre-commit run --all-files` and `npm run e2e` on every push to `main` and every pull request.

Linters and formatters run through [pre-commit](https://pre-commit.com) (see `.pre-commit-config.yaml`): Prettier, ESLint and `caddy fmt` fix formatting themselves, so just re-stage and commit again; `tsc` type-checks. [actionlint](https://github.com/rhysd/actionlint) and [zizmor](https://docs.zizmor.sh) check the GitHub Actions workflow (actions are pinned to commit SHAs). The TypeScript checks need `npm ci`; the Liquidsoap and Caddy checks run in Docker, so Docker must be running.

```sh
pre-commit install          # once after cloning: run the checks on every commit
pre-commit run --all-files  # run them by hand
```

In Claude Code cloud sessions, `.claude/hooks/session-start.sh` does all of this automatically: it installs pre-commit and `node_modules`, starts Docker, pulls the images, sets up Docker builds behind the session's proxy (so `npm run e2e` works) and installs the git hook.

## License

[MIT](LICENSE).
