#!/bin/sh
# Lint every file in this project. All tools run in Docker; nothing to install.
cd "$(dirname "$0")" || exit 1
failed=0
run() { echo "== $1"; shift; "$@" || failed=1; }
prettier() { docker run --rm -v "$PWD:/w" -w /w -e npm_config_update_notifier=false node:22-alpine npx -y prettier@3 "$@" compose.yml .pre-commit-config.yaml index.html; }

# ./check.sh --fix reformats the YAML and HTML files in place first.
[ "${1:-}" = "--fix" ] && prettier --write

run "compose.yml: compose schema" env PASSWORD=x STATS_PASSWORD_HASH=x docker compose config -q
run "compose.yml: yamllint" docker run --rm -v "$PWD:/data:ro" cytopia/yamllint -d relaxed compose.yml .pre-commit-config.yaml
# shellcheck disable=SC2016  # $(...) must expand inside the container
run "Caddyfile: validate" docker run --rm -v "$PWD/Caddyfile:/c:ro" caddy:2 sh -c 'STATS_PASSWORD_HASH=$(caddy hash-password --plaintext check) caddy adapt --config /c --validate >/dev/null'
run "Caddyfile: format" docker run --rm -v "$PWD/Caddyfile:/c:ro" caddy:2 sh -c 'caddy fmt /c | diff -u /c -'
run "radio.liq: liquidsoap --check" docker run --rm -v "$PWD/radio.liq:/r.liq:ro" savonet/liquidsoap:v2.3.3 --check /r.liq
run "YAML + HTML: prettier" prettier --check
run "index.html: htmlhint" docker run --rm -v "$PWD:/w:ro" -w /w -e npm_config_update_notifier=false node:22-alpine npx -y htmlhint@1 index.html
run "check.sh: shellcheck" docker run --rm -v "$PWD:/mnt:ro" koalaman/shellcheck:stable check.sh

if [ "$failed" = 0 ]; then echo "All checks passed"; else echo "Some checks FAILED"; exit 1; fi
