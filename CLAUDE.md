# Notes for Claude

## GitHub in Claude Code cloud sessions

- `gh pr create` and other GraphQL-based `gh` commands fail with HTTP 403. Use the REST API instead, e.g.:
  `gh api repos/alexkroman/radio/pulls -f base=main -f head=BRANCH -f title="..." -F body=@body.md`
- Docker builds can't reach package mirrors (e.g. `apk add` in `admin/Dockerfile`). Test with a local image that skips that step, and say the real build was not tested.

## Layout

- `shows/<slug>.md` defines a show that plays `music/<slug>/` (see README "Shows"); scheduling lives in `radio.liq`.
- `admin/server.mjs` is the admin site (dependency-free Node), served by Caddy at `/admin` behind basic auth.
- Caddy exposes only `/`, `/cover.jpg`, `/stream` and `/admin`; keep Icecast and Liquidsoap admin/status pages unreachable.
- Run `pre-commit run --all-files` before committing.
