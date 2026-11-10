# Radio

A small internet radio station built from stock open-source parts with almost no hand-written code:

- **Liquidsoap** plays scheduled shows on shuffle with automatic cue points, loudness levelling and crossfades, and lets a DJ take over live from [BUTT](https://danielnoethen.de/butt/).
- **Icecast** serves the stream.
- **Caddy** provides HTTPS and the player page (Pico.css, htmx, icecast-metadata-player).
- **Node** runs a small admin site (SoundExchange reports), with no npm dependencies.
- **Docker** restarts any service that crashes.

## Setup

Requires Docker.

```sh
cp .env.example .env   # then replace every change-me value, e.g. with: openssl rand -hex 16
mkdir -p music/default && cp ~/some/music/*.mp3 music/default/
docker compose up -d
```

Open <https://localhost/>. On localhost your browser warns about the certificate the first time; for a public station, add `DOMAIN=radio.example.com` to `.env` and Caddy gets a real certificate. See [`.env.example`](.env.example) for all settings.

## Everyday commands

| Command                             | What it does                                         |
| ----------------------------------- | ---------------------------------------------------- |
| `docker compose up -d`              | Start (or apply config changes)                      |
| `docker compose down`               | Stop (`down -v` also deletes stats and history!)     |
| `docker compose logs -f`            | Follow logs (Ctrl-C stops watching, not the station) |
| `docker compose ps`                 | Show which services are running                      |
| `docker compose restart caddy`      | Pick up edits to `Caddyfile` or `index.html`         |
| `docker compose restart liquidsoap` | Pick up edits to `shows/`                            |

Add or remove files in `music/<show>/` any time; they're picked up without a restart. Anything ffmpeg can decode works.

## Shows

Each `shows/<slug>.md` is a show that plays `music/<slug>/`. Front matter sets the title and, optionally, when it's on:

```md
---
title: Morning Mazes
when: 1w-5w and 6h-10h
---

Weekday mornings, 6–10am.
```

`when:` is [Liquidsoap time predicates](https://www.liquidsoap.info/doc-dev/language.html) joined by `and`: `6h-10h` (hours), `1w-5w` (Mon–Fri, `7w` = Sunday), `20h30m-22h`. Times use `TZ` from `.env`. A show without `when:` plays whenever nothing scheduled is on; when schedules overlap, the show with more terms wins. Shows switch at the end of the current track.

## Where things are

| URL                        | What's there                                                   |
| -------------------------- | -------------------------------------------------------------- |
| `https://localhost/`       | Player, now playing, history                                   |
| `https://localhost/stream` | The stream for apps and VLC                                    |
| `https://localhost/admin/` | Admin site (SoundExchange reports), `admin` / `ADMIN_PASSWORD` |

Nothing else is public: Icecast's status and admin pages are not reachable from outside, and Caddy answers 404 for any other path.

## Going live with BUTT

Settings → Server → Add: type **Icecast**, address = your server, port **8005**, mountpoint **live**, user **source**, password = `LIVE_PASSWORD`. Press play to take over (after a ~12 s buffer) and stop to fade back to the playlist. If you go silent for 20 s, the playlist takes over until you're audible again.

## Checks

Linters and formatters run through [pre-commit](https://pre-commit.com) (see `.pre-commit-config.yaml`); Prettier, Ruff and `caddy fmt` fix formatting themselves, so just re-stage and commit again. The Liquidsoap and Caddy checks run in Docker, so Docker must be running.

```sh
pre-commit install          # once after cloning: run the checks on every commit
pre-commit run --all-files  # run them by hand
```

In Claude Code cloud sessions, `.claude/hooks/session-start.sh` does all of this automatically: it installs pre-commit, starts Docker, pulls the check images and installs the git hook.
