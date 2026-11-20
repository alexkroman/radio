#!/bin/sh
# Writes Icecast's config (/tmp/icecast.xml) from the image's /etc/icecast.xml
# (which its entrypoint has filled with the passwords and limits from
# compose.yml). compose.yml runs it before starting Icecast. `config.sh reload`
# also tells the running Icecast to re-read it (SIGHUP), which keeps every
# listener connected: scripts/reconcile.sh runs it in the container on every
# deploy. (Always, not only when the file changed: a reload cut short between
# writing the file and the SIGHUP is then finished.)
#
# Buffering for slow connections (the streams are 256 kbps, 32 KB/s):
#   - burst-size: a new listener gets ~10 s of audio at once (default 64 KB,
#     ~2 s), so the player starts with a full buffer instead of an empty one.
#   - queue-size: a listener whose connection stalls can fall ~32 s behind
#     before Icecast drops it (default 512 KB, ~16 s). Must exceed burst-size.
#
# Keeping listeners through a Liquidsoap restart (as AzuraCast does): while the
# stream's source (/stream) is gone its listeners get silence.mp3 (looped; same
# 256 kbps MP3 format as radio.liq's output), and fallback-override moves them
# back when it returns, so players stay connected instead of dropping. Icecast
# 2.5 ignores fallbacks on the default mount, so /stream gets its own <mount>,
# and so does each show's own stream, /stream/<slug> (one per shows/<slug>.md:
# reconcile.sh reloads this on every deploy, so a new show's has it). Each
# has a fallback of its own (/fallback-stream.mp3, /fallback-stream-<slug>.mp3):
# when a stream returns, fallback-override moves everyone on its fallback to
# it, so with one shared fallback the first stream back took every stream's
# listeners.
set -eu
here=$(dirname "$0")
web=/tmp/web
mkdir -p "$web"
cp -R /usr/share/icecast/web/. "$web/"
mounts=
for f in /stream /shows/*.md; do
  case $f in /shows/*) [ -e "$f" ] || continue && mount=/stream/$(basename "$f" .md) ;; *) mount=$f ;; esac
  fallback=/fallback$(printf %s "$mount" | tr / -).mp3
  cp "$here/silence.mp3" "$web$fallback"
  mounts="$mounts<mount type=\"normal\"><mount-name>$mount</mount-name><fallback-mount>$fallback</fallback-mount><fallback-override>all</fallback-override></mount>"
done
# Seed Icecast's random numbers from /dev/urandom and /proc; without it, it
# warns at every start and uses libigloo's defaults.
prng='<prng-seed type="profile">linux</prng-seed>'
sed \
  -e "s|<hostname>localhost</hostname>|<hostname>$DOMAIN</hostname>|" \
  -e "s|<webroot>[^<]*</webroot>|<webroot>$web</webroot>|" \
  -e "s|</security>|$prng</security>|" \
  -e "s|</icecast>|<mount type=\"default\"><charset>UTF-8</charset></mount>$mounts</icecast>|" \
  -e 's|<burst-size>[0-9]*</burst-size>|<burst-size>327680</burst-size>|' \
  -e 's|<queue-size>[0-9]*</queue-size>|<queue-size>1048576</queue-size>|' \
  /etc/icecast.xml >/tmp/icecast.xml.new
chmod 600 /tmp/icecast.xml.new
for want in '<charset>UTF-8' "$prng" '<burst-size>327680<' '<queue-size>1048576<' "<webroot>$web<"; do
  grep -qF "$want" /tmp/icecast.xml.new || {
    echo "config.sh: $want missing from the generated config" >&2
    exit 1
  }
done
mv /tmp/icecast.xml.new /tmp/icecast.xml
# Icecast is the container's PID 1 (compose.yml execs it).
if [ "${1:-}" = reload ]; then kill -HUP 1; fi
