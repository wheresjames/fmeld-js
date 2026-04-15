#!/bin/sh
set -eu

mkdir -p /srv/data

if [ -z "$(ls -A /srv/data 2>/dev/null)" ]; then
    cp -a /seed/. /srv/data/
fi

exec python /usr/local/bin/ftp-server.py
