#!/bin/sh
set -eu

mkdir -p /srv/share /run/samba

if [ -z "$(ls -A /srv/share 2>/dev/null)" ]; then
    cp -a /seed/. /srv/share/
fi

chown -R demo:demo /srv/share

exec /usr/sbin/smbd --foreground --no-process-group
