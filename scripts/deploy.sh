#!/bin/sh
# Deploy to OVHcloud VPS (or provision one on first run); see README.md
# "Deploy to OVHcloud". Set FLAVOR for a different server size, or IP=<address>
# (or IP= in .env) to skip the OpenStack CLI.
set -eu
cd "$(dirname "$0")/.."
export OS_REGION_NAME="${OS_REGION_NAME:-US-WEST-OR-1}"
[ -f .env ] || { echo "Create .env first (see .env.example)" >&2 && exit 1; }

# The server mirrors this checkout, so deploy only main as it is on GitHub: a
# branch (a PR not merged yet) would go live, and the next deploy of main would
# quietly undo it. Files git doesn't track (music/, covers/, shows/ besides
# their .md files) are synced as they are.
git fetch -q origin main
if [ "$(git branch --show-current)" != main ] ||
  [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ] ||
  ! git diff --quiet HEAD; then
  echo "Deploy from main as on GitHub, with nothing uncommitted:" >&2
  echo "  git checkout main && git pull" >&2
  exit 1
fi
# A show without its music folder would play nothing but silence.
for show in shows/*.md; do
  slug=$(basename "$show" .md)
  [ -d "music/$slug" ] || { echo "$show has no music/$slug/" >&2 && exit 1; }
done
SSH="ssh -o StrictHostKeyChecking=accept-new -o ControlMaster=auto -o ControlPath=$HOME/.ssh/radio-%C -o ControlPersist=60"
ipv4() { grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' | head -n1; }

if [ -z "${IP:-}" ]; then
  IP=$(grep -E '^IP=' .env | cut -d= -f2- 2>/dev/null || true)
fi
if [ -z "${IP:-}" ]; then
  IP=$(openstack server show radio -f value -c addresses 2>/dev/null | ipv4 || true)
fi
if [ -z "$IP" ]; then
  openstack keypair show radio >/dev/null 2>&1 ||
    openstack keypair create --public-key "${SSH_KEY:-$HOME/.ssh/id_ed25519.pub}" radio >/dev/null
  # Only SSH and HTTPS (Caddy) are reachable from outside.
  openstack security group show radio >/dev/null 2>&1 || {
    openstack security group create radio >/dev/null
    openstack security group rule create --protocol tcp --dst-port 22 radio >/dev/null
    openstack security group rule create --protocol tcp --dst-port 443 radio >/dev/null
  }
  IP=$(openstack server create --wait --flavor "${FLAVOR:-b3-8}" --image "Ubuntu 24.04" \
    --network Ext-Net --key-name radio --security-group radio \
    --user-data scripts/cloud-init.yml -f value -c addresses radio | ipv4)
  until $SSH "ubuntu@$IP" cloud-init status --wait >/dev/null 2>&1; do sleep 5; done
fi
HOST=ubuntu@$IP

# Mirror local files to the server. -O: the ubuntu user can't set times on the
# dirs compose.yml's init service owns. -i lists each change as it happens; tee
# keeps a copy in $log to know what changed (sh has no pipefail, so rsync's exit
# status goes through $log.status).
log=$(mktemp)
trap 'rm -f "$log" "$log.status"' EXIT
rs() {
  { rsync -rltO --delete --chmod=D755,F644 -e "$SSH" -i "$@" ||
    echo $? >"$log.status"; } | tee -a "$log"
  [ ! -s "$log.status" ]
}

# Sync everything.
{ git ls-files -z && printf '.env\0'; } | rs --from0 --files-from=- ./ "$HOST:radio/"
rs music covers shows "$HOST:radio/"
out=$(cat "$log")

# Pre-create bind-mounted dirs so Docker doesn't create them as root on first run.
# No build attestations: they're stamped with the build time, so every deploy
# made a new app image (even one built all from cache) and recreated the app.
$SSH "$HOST" 'chmod 600 radio/.env && cd radio &&
  mkdir -p music plays logs covers &&
  BUILDX_NO_DEFAULT_ATTESTATIONS=1 docker compose up -d --build --remove-orphans'

changed() { printf '%s\n' "$out" | grep -qF "$1"; }

# Neither step below drops a listener. Icecast builds each show's fallback mount
# from shows/ (icecast/config.sh); reloading its config keeps everyone
# connected, unlike a restart. Liquidsoap reads radio.liq once at startup and
# builds one output per show slug; while it restarts, listeners hear the
# fallback. So when a show file is added or removed (rsync's ">f+++++++++" and
# "*deleting"), reload Icecast first (the new show gets its fallback) and then
# restart Liquidsoap. Edits to a show (">f.st......") or anything under
# shows/djs/ need neither: only the app reads them, on every request.
shows_changed=$(printf '%s\n' "$out" | grep -cE '^(>f\+{9}|\*deleting) +shows/[^/]+\.md$' || true)
if [ "$shows_changed" -gt 0 ] || changed icecast/; then
  $SSH "$HOST" 'cd radio && docker compose exec -T icecast sh /icecast/config.sh reload'
fi
# radio.liq is a single-file bind mount, so the container keeps the file it
# started with after rsync replaces it: restart when that differs from the
# synced one, rather than when this run's rsync changed it, so a deploy that
# stopped after the sync but before this restart is caught up by the next one.
# (A restart mounts the file afresh.)
liq_stale=$($SSH "$HOST" 'cd radio &&
  docker compose exec -T liquidsoap cat /radio.liq | cmp -s - radio.liq || echo yes')
if [ "$shows_changed" -gt 0 ] || [ -n "$liq_stale" ]; then
  $SSH "$HOST" 'cd radio && docker compose restart liquidsoap'
fi

# Caddy reloads its config in place without dropping connections (a no-op
# when it's unchanged), so do it every time, which also catches up after an
# interrupted deploy. Its output (info lines like "using config from file")
# is shown only if the reload fails.
# shellcheck disable=SC2016 # $out expands on the server
$SSH "$HOST" 'cd radio &&
  out=$(docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile 2>&1) ||
  { printf "%s\n" "$out" >&2; exit 1; }'

# Back up the play log (the only record for SoundExchange reports) to
# backup/plays/. Never deletes, and never touches the local plays/.
mkdir -p backup/plays
rsync -rt -e "$SSH" "$HOST:radio/plays/" backup/plays/
echo "Deployed to $IP"
