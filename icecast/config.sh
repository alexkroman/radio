#!/bin/sh
# Writes Icecast's config (/tmp/icecast.xml) from the image's /etc/icecast.xml
# (which its entrypoint has filled with the passwords and limits from
# compose.yml) and the shows in /shows. compose.yml runs it before starting
# Icecast. `config.sh reload` also tells the running Icecast to re-read it
# (SIGHUP), which keeps every listener connected: scripts/deploy.sh runs it in
# the container when a show is added or removed, instead of a restart.
#
# Buffering for slow connections (the streams are 256 kbps, 32 KB/s):
#   - burst-size: a new listener gets ~10 s of audio at once (default 64 KB,
#     ~2 s), so the player starts with a full buffer instead of an empty one.
#   - queue-size: a listener whose connection stalls can fall ~32 s behind
#     before Icecast drops it (default 512 KB, ~16 s). Must exceed burst-size.
#
# Keeping listeners through a Liquidsoap restart (as AzuraCast does): while a
# show's source is gone its listeners get silence.mp3 (looped; same 256 kbps
# MP3 format as radio.liq's output), and fallback-override moves them back when
# it returns, so players stay connected instead of dropping. Icecast 2.5
# ignores fallbacks on the default mount, so each show gets its own <mount>,
# and its own copy of the file: listeners on a shared fallback would all go
# back to whichever show returned first.
set -eu
here=$(dirname "$0")
web=/tmp/web
mkdir -p "$web"
cp -R /usr/share/icecast/web/. "$web/"
rm -f "$web"/fallback-*.mp3
mounts=
for f in /shows/*.md; do
  [ -e "$f" ] || continue
  slug=$(basename "$f" .md)
  cp "$here/silence.mp3" "$web/fallback-$slug.mp3"
  mounts="$mounts<mount type=\"normal\"><mount-name>/$slug</mount-name><fallback-mount>/fallback-$slug.mp3</fallback-mount><fallback-override>1</fallback-override></mount>"
done
sed \
  -e "s|<hostname>localhost</hostname>|<hostname>$DOMAIN</hostname>|" \
  -e 's|<errorlog>-</errorlog>|<errorlog>error.log</errorlog>|' \
  -e "s|<webroot>[^<]*</webroot>|<webroot>$web</webroot>|" \
  -e "s|</icecast>|<mount type=\"default\"><charset>UTF-8</charset></mount>$mounts</icecast>|" \
  -e 's|<burst-size>[0-9]*</burst-size>|<burst-size>327680</burst-size>|' \
  -e 's|<queue-size>[0-9]*</queue-size>|<queue-size>1048576</queue-size>|' \
  /etc/icecast.xml >/tmp/icecast.xml.new
chmod 600 /tmp/icecast.xml.new
for want in '<charset>UTF-8' '<burst-size>327680<' '<queue-size>1048576<' "<webroot>$web<"; do
  grep -qF "$want" /tmp/icecast.xml.new || {
    echo "config.sh: $want missing from the generated config" >&2
    exit 1
  }
done
mv /tmp/icecast.xml.new /tmp/icecast.xml
# Icecast is the container's PID 1 (compose.yml execs it).
if [ "${1:-}" = reload ]; then kill -HUP 1; fi
