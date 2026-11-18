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
# The shows' hours must cover every hour of the day exactly once: a gap would
# be silence on air.
node app/check-schedule.ts || exit 1
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

# Mirror local files to the server, in an order that never puts anything on
# air (or on a page) before what it needs is there, nor takes anything away
# while it's still in use:
#   1. Add new covers, then new music (Liquidsoap watches the music folders,
#      and a track's cover must be there when it starts), deleting nothing.
#   2. Copy the code (every tracked file but the shows) and .env, pull the
#      images and build the app's while the old containers keep running.
#   3. Copy the shows (a new show only now that its music and covers are
#      there; Liquidsoap re-reads the hours every minute), then at once start
#      the new containers and restart Liquidsoap if the shows changed
#      (scripts/reconcile.sh), which drops no listener.
#   4. Only then delete the music and covers that went: a removed show's
#      until Liquidsoap stopped playing it, and a removed track's cover after
#      the track.
# -O: the ubuntu user can't set times on the dirs compose.yml's init service
# owns. -i lists each change. Finder's .DS_Store files stay home (Liquidsoap
# would try to play one in music/), and --delete-excluded removes any there.
rs() { rsync -rltO --chmod=D755,F644 --exclude=.DS_Store -e "$SSH" -i "$@"; }
rs covers "$HOST:radio/"
rs music "$HOST:radio/"
{ git ls-files -z -- ':!shows/' && printf '.env\0'; } | rs --from0 --files-from=- ./ "$HOST:radio/"
# No build attestations: they're stamped with the build time, so every deploy
# made a new app image (even one built all from cache) and recreated the app.
$SSH "$HOST" 'chmod 600 radio/.env && cd radio &&
  docker compose pull -q --ignore-buildable &&
  BUILDX_NO_DEFAULT_ATTESTATIONS=1 docker compose build'
rs --delete shows "$HOST:radio/"
# Pre-create bind-mounted dirs so Docker doesn't create them as root on first
# run. The images are built (step 2), so `up` only swaps in what changed.
$SSH "$HOST" 'cd radio &&
  mkdir -p music plays logs covers &&
  docker compose up -d --no-build --remove-orphans &&
  sh scripts/reconcile.sh'
rs --delete --delete-excluded music "$HOST:radio/"
rs --delete --delete-excluded covers "$HOST:radio/"

# Back up the play log (the only record for SoundExchange reports) to
# backup/plays/. Never deletes, and never touches the local plays/.
mkdir -p backup/plays
rsync -rt -e "$SSH" "$HOST:radio/plays/" backup/plays/
echo "Deployed to $IP"
