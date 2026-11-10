#!/bin/bash
# Claude Code cloud sessions: get `pre-commit run --all-files` and `npm run e2e`
# working out of the box. Installs pre-commit and node_modules, starts Docker,
# pre-pulls images, sets up Docker builds behind the proxy and installs the git hook. Idempotent; quick once everything is cached.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}"

# pre-commit
if ! command -v pre-commit >/dev/null; then
  if command -v uv >/dev/null; then
    uv tool install pre-commit
  else
    python3 -m pip install --user pre-commit
  fi
fi
export PATH="$HOME/.local/bin:$PATH"

# Docker daemon (the container ships the binaries but doesn't start it).
if ! docker info >/dev/null 2>&1; then
  setsid nohup dockerd >/tmp/dockerd.log 2>&1 </dev/null &
  for _ in $(seq 1 30); do
    docker info >/dev/null 2>&1 && break
    sleep 1
  done
fi

# Images used by the docker_image hooks. Docker Hub often rate-limits shared
# cloud IPs (429), so fall back to Google's Docker Hub mirror and retag.
pull() {
  local img=$1 mirror
  docker image inspect "$img" >/dev/null 2>&1 && return 0
  case "$img" in
  */*) mirror="mirror.gcr.io/$img" ;;
  *) mirror="mirror.gcr.io/library/$img" ;;
  esac
  for attempt in 1 2 3; do
    docker pull -q "$img" >/dev/null 2>&1 && return 0
    docker pull -q "$mirror" >/dev/null 2>&1 && docker tag "$mirror" "$img" && return 0
    sleep $((attempt * 10))
  done
  echo "warning: could not pull $img; its pre-commit hook will fail until it can" >&2
}
if docker info >/dev/null 2>&1; then
  # Images for the docker_image hooks, compose.yml and the Dockerfile (e2e suite).
  {
    grep -E '^\s*entry:' .pre-commit-config.yaml |
      grep -oE '[a-z0-9][a-z0-9._/-]*[a-z][a-z0-9._/-]*:[A-Za-z0-9._-]+'
    grep -E '^\s*image: .*:' compose.yml | awk '{print $2}'
    grep -E '^FROM ' Dockerfile | awk '{print $2}'
  } | sort -u | while read -r img; do pull "$img"; done
else
  echo "warning: Docker daemon did not start (see /tmp/dockerd.log)" >&2
fi

# Node deps: the tsc/eslint hooks and `npm run e2e` need node_modules.
npm ci --no-audit --no-fund

# `npm run e2e`: Docker builds reach npm through this session's HTTPS proxy, so
# test/e2e.sh adds .claude/compose.cloud.yml (host network + these secrets) and
# lets buildx bake use them.
printf 'https-proxy=%s\nproxy=%s\ncafile=/run/secrets/ca\n' "$HTTPS_PROXY" "$HTTPS_PROXY" >"$HOME/.npmrc-docker"
echo "export E2E_COMPOSE=.claude/compose.cloud.yml E2E_BAKE_FLAGS=--allow=network.host BUILDX_BAKE_ENTITLEMENTS_FS=0" >>"${CLAUDE_ENV_FILE:-/dev/null}"

# Git hook + hook environments (pre-commit caches these in ~/.cache/pre-commit).
pre-commit install
pre-commit install-hooks

# shellcheck disable=SC2016 # expanded when the env file is sourced
echo 'export PATH="$HOME/.local/bin:$PATH"' >>"${CLAUDE_ENV_FILE:-/dev/null}"
