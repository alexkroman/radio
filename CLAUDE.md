# Notes for Claude

## GitHub in Claude Code cloud sessions

- `gh pr create` and other GraphQL-based `gh` commands fail with HTTP 403. Use the REST API instead, e.g.:
  `gh api repos/alexkroman/radio/pulls -f base=main -f head=BRANCH -f title="..." -F body=@body.md`

## Docker builds and e2e in cloud sessions

- Docker builds reach npm only through the session's HTTPS proxy. `.claude/hooks/session-start.sh` sets `E2E_COMPOSE`, `E2E_BAKE_FLAGS` and `BUILDX_BAKE_ENTITLEMENTS_FS`, so `npm run e2e` just works; for a manual build use `docker buildx bake --load $E2E_BAKE_FLAGS -f compose.yml -f .claude/compose.cloud.yml app` (`docker compose build` can't pass `--allow=network.host`).
- If a Docker build's `npm ci` fails with ECONNREFUSED, the session proxy's port changed (the sandbox was recycled): rewrite `~/.npmrc-docker` from `$HTTPS_PROXY` as `.claude/hooks/session-start.sh` does.
- Run `npm run e2e` after changing anything in the stack; it is the only test of the real system. CI (`.github/workflows/ci.yml`) runs it and pre-commit too.

## Layout

- `shows/<slug>.md` is a show: a 24/7 MP3 stream (Liquidsoap → Icecast mount `/<slug>`, public at `/<slug>/stream` via Caddy) playing `music/<slug>/`. Icecast stays because Liquidsoap's own HTTP output (`output.harbor`, 2.3.3) sends no ICY metadata, so players would get no track titles (`test/hunt.spec.ts` checks). `radio.liq` builds one stream per show and appends each play (with tags, and the listener count from Icecast's status-json) to `plays/YYYY-MM.jsonl`. Per-track work hangs off the playlist source's `on_track`: the crossfaded source doesn't mark every track.
- `app/` is one Hono (+ hono/jsx) app: `server.tsx` (show list, player, covers), `admin.tsx` (`/admin`, Hono basicAuth, SoundExchange report), `login.tsx` (optional `SITE_PASSWORD` signed-cookie login), `plays.ts` (reads the play log), `client.ts` (browser bundle: htmx, icecast-metadata-player, the hand-written `style.css`/`tokens.css`, fonts from `@fontsource`; no CDNs). The CSP forbids eval, so no htmx trigger filters.
- Caddy routes GET/HEAD `/<slug>/stream` to Icecast and everything else to the app. `login.tsx` also throttles failed logins (site form and admin basic auth).
- `test/`: `e2e.sh` + `compose.yml` overlay + Playwright specs on `fixtures/`; `global-setup.ts` logs in with `SITE_PASSWORD`.
- Run `pre-commit run --all-files` before committing.
