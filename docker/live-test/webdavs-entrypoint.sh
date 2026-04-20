#!/bin/sh
set -eu
mkdir -p /srv/data
if [ -z "$(ls -A /srv/data 2>/dev/null)" ]; then
    cp -a /seed/. /srv/data/
fi
exec rclone serve webdav /srv/data \
    --addr :8443 \
    --user demo \
    --pass password \
    --cert /certs/webdavs.crt \
    --key  /certs/webdavs.key
