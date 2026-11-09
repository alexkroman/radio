# Radio

A small internet radio station built from stock open-source parts with almost no hand-written code:

- **Liquidsoap** plays `music/` on shuffle with automatic cue points, loudness levelling and crossfades, and lets a DJ take over live from [BUTT](https://danielnoethen.de/butt/).
- **Icecast** serves the stream.
- **Caddy** provides HTTPS and the player page (Pico.css, htmx, icecast-metadata-player).
- **GoAccess** provides listener stats with countries.
- **autoheal** restarts any service whose health check fails.

## Setup

Requires Docker.

```sh
printf 'PASSWORD=%s\nLIVE_PASSWORD=%s\n' "$(openssl rand -hex 16)" "$(openssl rand -hex 16)" > .env
cp ~/some/music/*.mp3 music/
docker compose up -d
```

Open <https://localhost/>. On localhost your browser warns about the certificate the first time; for a public station, add `DOMAIN=radio.example.com` to `.env` and Caddy gets a real certificate. See [`.env.example`](.env.example) for all settings.

## Everyday commands

| Command                        | What it does                                         |
| ------------------------------ | ---------------------------------------------------- |
| `docker compose up -d`         | Start (or apply config changes)                      |
| `docker compose down`          | Stop (`down -v` also deletes stats and history!)     |
| `docker compose logs -f`       | Follow logs (Ctrl-C stops watching, not the station) |
| `docker compose ps`            | Show services and their health                       |
| `docker compose restart caddy` | Pick up edits to `Caddyfile` or `index.html`         |

Add or remove files in `music/` any time; they're picked up without a restart. Anything ffmpeg can decode works.

## Where things are

| URL                                  | What's there                                                                                                                           |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `https://localhost/`                 | Player, now playing, history                                                                                                           |
| `https://localhost/stream`           | The stream for apps and VLC                                                                                                            |
| `http://<this machine's IP>/stream`  | Same stream over plain HTTP, for devices on your network that can't verify the certificate (e.g. a WiiM: Browse → Open Network Stream) |
| `https://localhost/stats/index.html` | Listener stats, `admin` / `PASSWORD`                                                                                                   |
| `https://localhost/admin/`           | Icecast admin, `admin` / `PASSWORD`                                                                                                    |

## Going live with BUTT

Settings → Server → Add: type **Icecast**, address = your server, port **8005**, mountpoint **live**, user **source**, password = `LIVE_PASSWORD`. Press play to take over (after a ~12 s buffer) and stop to fade back to the playlist. If you go silent for 20 s, the playlist takes over until you're audible again.

## Checks

```sh
./check.sh                 # linters and formatters (runs on every commit via pre-commit)
./check.sh --fix           # reformat YAML, HTML and Markdown first
./check.sh --integration   # also boot the core stack on spare ports and test it (~15 s)
```

Run `pre-commit install` once after cloning to enable the commit hook.
