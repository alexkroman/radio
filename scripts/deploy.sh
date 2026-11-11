#!/bin/sh
# Deploy the station to an OVHcloud Public Cloud server in Hillsboro, Oregon
# (region US-WEST-OR-1), using only stock tools: the OpenStack CLI to create the
# server (once), cloud-init to install Docker, rsync + ssh to ship and start it.
#
#   pipx install python-openstackclient     # once
#   . ./openrc.sh                           # OVHcloud: Public Cloud → Users & Roles → OpenStack RC (region US-WEST-OR-1)
#   scripts/deploy.sh                       # first run creates the server; later runs just update it
#
# Override with NAME, FLAVOR (`openstack flavor list`), IMAGE, SSH_KEY.
set -eu
cd "$(dirname "$0")/.."
: "${OS_REGION_NAME:=US-WEST-OR-1}"
export OS_REGION_NAME
NAME=${NAME:-radio} FLAVOR=${FLAVOR:-b3-8} IMAGE=${IMAGE:-Ubuntu 24.04}
SSH_KEY=${SSH_KEY:-$HOME/.ssh/id_ed25519.pub}
[ -f .env ] || { echo "Create .env first (see .env.example)" >&2 && exit 1; }

if ! openstack server show "$NAME" >/dev/null 2>&1; then
  openstack keypair show "$NAME" >/dev/null 2>&1 ||
    openstack keypair create --public-key "$SSH_KEY" "$NAME" >/dev/null
  # Only SSH and HTTPS (Caddy) are reachable from outside.
  if ! openstack security group show "$NAME" >/dev/null 2>&1; then
    openstack security group create "$NAME" >/dev/null
    for port in 22 443; do
      openstack security group rule create --protocol tcp --dst-port "$port" "$NAME" >/dev/null
    done
  fi
  openstack server create --wait --flavor "$FLAVOR" --image "$IMAGE" \
    --network Ext-Net --key-name "$NAME" --security-group "$NAME" \
    --user-data scripts/cloud-init.yml "$NAME" >/dev/null
fi

IP=$(openstack server show "$NAME" -f value -c addresses | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' | head -n1)
HOST=ubuntu@$IP
SSH="ssh -o StrictHostKeyChecking=accept-new"
until $SSH "$HOST" cloud-init status --wait >/dev/null 2>&1; do sleep 5; done

# Code, config, shows/ and music/. The station's own data (logs/, covers/,
# plays/) lives only on the server and is never overwritten.
rsync -rlt --delete --chmod=D755,F644 -e "$SSH" \
  --exclude=.git --exclude=node_modules --exclude=dist --exclude=test-results \
  --exclude=playwright-report --exclude='/logs/*' --exclude='/covers/*' --exclude='/plays/*' \
  ./ "$HOST:radio/"
$SSH "$HOST" 'chmod 600 radio/.env && cd radio && docker compose up -d --build --remove-orphans'
echo "Deployed to $IP"
