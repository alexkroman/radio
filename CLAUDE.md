# Notes for Claude

## GitHub in Claude Code cloud sessions

- `gh pr create` and other GraphQL-based `gh` commands fail with HTTP 403. Use the REST API instead, e.g.:
  `gh api repos/alexkroman/radio/pulls -f base=main -f head=BRANCH -f title="..." -F body=@body.md`

## Docker builds and e2e in cloud sessions

- Docker builds reach npm only through the session's HTTPS proxy. `.claude/hooks/session-start.sh` sets `E2E_COMPOSE`, `E2E_BAKE_FLAGS` and `BUILDX_BAKE_ENTITLEMENTS_FS`, so `npm run e2e` just works; for a manual build use `docker buildx bake --load $E2E_BAKE_FLAGS -f compose.yml -f .claude/compose.cloud.yml site` (`docker compose build` can't pass `--allow=network.host`).
- Run `npm run e2e` after changing anything in the stack; it is the only test of the real system.

## Layout

- `shows/<slug>.md` is a show: a 24/7 stream (Icecast mount `/<slug>`, public at `/<slug>/stream`) playing `music/<slug>/`. `radio.liq` builds one stream per show.
- `site/` (Hono + hono/jsx) serves `/` (show list), `/<slug>` (player) and `/<slug>/cover.jpg`; `site/client.ts` is the browser bundle (htmx, icecast-metadata-player, Pico CSS from npm, no CDNs). The CSP forbids eval, so no htmx trigger filters.
- `admin/` (Hono) is the admin site at `/admin` behind Caddy basic auth.
- Caddy exposes only the site, `/<slug>/stream` and `/admin`; keep Icecast and Liquidsoap admin/status pages unreachable (the e2e suite checks this).
- `test/`: `e2e.sh` + `compose.yml` overlay + Playwright `e2e.spec.ts` on `fixtures/`.
- Run `pre-commit run --all-files` before committing.
