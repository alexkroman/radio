#!/bin/sh
# Deploy to OVHcloud Public Cloud in Hillsboro (US-WEST-OR-1); see README.md
# "Deploy to OVHcloud". `scripts/deploy.sh` deploys everything (creating the
# server on first run); `scripts/deploy.sh media` only syncs music/, covers/
# and shows/. Set FLAVOR for another server size, or IP=<address> to skip the
# OpenStack CLI.
set -eu
cd "$(dirname "$0")/.."
export OS_REGION_NAME="${OS_REGION_NAME:-US-WEST-OR-1}"
[ -f .env ] || { echo "Create .env first (see .env.example)" >&2 && exit 1; }
SSH="ssh -o StrictHostKeyChecking=accept-new -o ControlMaster=auto -o ControlPath=$HOME/.ssh/radio-%C -o ControlPersist=60"
ipv4() { grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' | head -n1; }

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
# dirs compose.yml's init service owns.
rs() { rsync -rltO --delete --chmod=D755,F644 -e "$SSH" "$@"; }

# music/, covers/ and shows/ (deletions too). Liquidsoap reads the show list
# at startup, so restart it when a show is added or removed.
media() {
  out=$(rs -i music covers shows "$HOST:radio/")
  if printf '%s\n' "$out" | grep -qE '^(>f\+|\*deleting) +shows/'; then
    $SSH "$HOST" 'cd radio && docker compose restart liquidsoap'
  fi
}

if [ "${1:-}" != media ]; then
  # The code is what git tracks (commit or `git add` new files), plus .env.
  { git ls-files -z && printf '.env\0'; } | rs --from0 --files-from=- ./ "$HOST:radio/"
  # Pre-create bind-mounted dirs so Docker doesn't create them as root on first run.
  $SSH "$HOST" 'chmod 600 radio/.env && cd radio &&
    mkdir -p music plays logs covers &&
    docker compose up -d --build --remove-orphans'
fi
media
# Back up the play log (the only record for SoundExchange reports) to
# backup/plays/. Never deletes, and never touches the local plays/.
mkdir -p backup/plays
rsync -rt -e "$SSH" "$HOST:radio/plays/" backup/plays/
echo "Deployed to $IP"
