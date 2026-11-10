# Radio

A small internet radio station: stock open-source services plus one small TypeScript app.

- **Liquidsoap** plays each show as its own 24/7 stream, on shuffle with automatic cue points, loudness levelling and crossfades, and appends every play (tags and listener count) to a monthly log, `plays/YYYY-MM.jsonl`.
- **Icecast** serves the streams, with track titles (UTF-8) in the stream for players like VLC.
- **`app/`** ([Hono](https://hono.dev)) serves the show list, the player pages and the admin site (SoundExchange reports from the play log). Its browser code (htmx, icecast-metadata-player, Pico CSS) is bundled from npm, so nothing loads from a CDN.
- **Caddy** provides HTTPS and is the only public entry point.
- **Docker** restarts any service that crashes.

## Setup

Requires Docker.

```sh
cp .env.example .env              # then replace every change-me value, e.g. with: openssl rand -hex 16
mkdir -p music/<slug>             # one directory per show (e.g. music/myshow)
cp ~/some/music/*.mp3 music/<slug>/
# create shows/<slug>.md for each show (see Shows below; shows/ is gitignored)
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
| `docker compose restart caddy`      | Pick up edits to `Caddyfile`                         |
| `docker compose restart liquidsoap` | Pick up edits to `shows/`                            |

Add or remove files in `music/<show>/` any time; they're picked up without a restart. Anything ffmpeg can decode works.

## Shows

Each `shows/<slug>.md` is a show: its own 24/7 stream at `/<slug>/stream`, playing `music/<slug>/` on shuffle, with a player page at `/<slug>`. Slugs are lowercase letters, digits and hyphens. The front matter sets the title; the body is the description shown on the page:

```md
---
title: My Show
---

A description shown on the player page.
```

`shows/` is gitignored — create your own show files after cloning. Adding or removing a show needs `docker compose restart liquidsoap`; editing a title or description shows up immediately.

## Where things are

| URL                               | What's there                                                   |
| --------------------------------- | -------------------------------------------------------------- |
| `https://localhost/`              | List of shows                                                  |
| `https://localhost/<slug>`        | A show's player, now playing, history                          |
| `https://localhost/<slug>/stream` | A show's stream for apps and VLC                               |
| `https://localhost/admin/`        | Admin site (SoundExchange reports), `admin` / `ADMIN_PASSWORD` |

Set `SITE_PASSWORD` in `.env` to put the show pages behind a login form; the streams stay public so apps can play them. After 10 wrong passwords (site or admin) from one address, logins are refused for 15 minutes. Nothing else is public.

## Development

Node 22 for the TypeScript (`app/`, `test/`):

```sh
npm ci              # once after cloning
npm run typecheck   # tsc
npm run lint        # eslint
npm run build       # esbuild → dist/ (the Docker image does this too)
```

## End-to-end tests

`npm run e2e` builds the images, starts the real stack (Caddy, Icecast, Liquidsoap, the app) on the fixture shows and music in `test/fixtures/`, runs the Playwright suites in `test/` from a container inside Caddy's network, and tears everything down. It needs only Docker, uses its own compose project (`radio-e2e`) and throwaway volumes, publishes no ports, and doesn't touch `logs/`, `covers/`, `plays/` or `music/`. Pass Playwright arguments through, e.g. `npm run e2e -- -g "admin"`.

## Checks

CI (`.github/workflows/ci.yml`, GitHub Actions) runs `pre-commit run --all-files` and `npm run e2e` on every push to `main` and every pull request.

Linters and formatters run through [pre-commit](https://pre-commit.com) (see `.pre-commit-config.yaml`): Prettier, ESLint and `caddy fmt` fix formatting themselves, so just re-stage and commit again; `tsc` type-checks. [actionlint](https://github.com/rhysd/actionlint) and [zizmor](https://docs.zizmor.sh) check the GitHub Actions workflow (actions are pinned to commit SHAs). The TypeScript checks need `npm ci`; the Liquidsoap and Caddy checks run in Docker, so Docker must be running.

```sh
pre-commit install          # once after cloning: run the checks on every commit
pre-commit run --all-files  # run them by hand
```

In Claude Code cloud sessions, `.claude/hooks/session-start.sh` does all of this automatically: it installs pre-commit and `node_modules`, starts Docker, pulls the images, sets up Docker builds behind the session's proxy (so `npm run e2e` works) and installs the git hook.
