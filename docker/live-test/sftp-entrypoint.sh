#!/bin/sh
set -eu

mkdir -p /home/demo/data /var/run/sshd

if [ -z "$(ls -A /home/demo/data 2>/dev/null)" ]; then
    cp -a /seed/. /home/demo/data/
    chown -R demo:demo /home/demo/data
fi

ssh-keygen -A

exec /usr/sbin/sshd -D -e
