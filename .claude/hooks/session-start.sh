#!/bin/bash
# Claude Code cloud sessions: get `pre-commit run --all-files` working out of the box.
# Installs pre-commit, starts Docker (several hooks run in containers), pre-pulls
# those images and installs the git hook. Idempotent; quick once everything is cached.
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
  setsid nohup dockerd >/tmp/dockerd.log 2>&1 < /dev/null &
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
  grep -E '^\s*entry:' .pre-commit-config.yaml |
    grep -oE '[a-z0-9][a-z0-9._/-]*[a-z][a-z0-9._/-]*:[A-Za-z0-9._-]+' |
    sort -u | while read -r img; do pull "$img"; done
else
  echo "warning: Docker daemon did not start (see /tmp/dockerd.log)" >&2
fi

# Git hook + hook environments (pre-commit caches these in ~/.cache/pre-commit).
pre-commit install
pre-commit install-hooks

echo "export PATH=\"\$HOME/.local/bin:\$PATH\"" >> "${CLAUDE_ENV_FILE:-/dev/null}"
