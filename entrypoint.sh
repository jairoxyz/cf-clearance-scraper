#!/bin/sh
set -e

# set timezone from env
TZ="${TZ:-Europe/Madrid}"

if [ -f "/usr/share/zoneinfo/$TZ" ]; then
  ln -snf "/usr/share/zoneinfo/$TZ" /etc/localtime
  echo "$TZ" > /etc/timezone
else
  echo "WARNING: Invalid TZ '$TZ', falling back to UTC"
  ln -snf /usr/share/zoneinfo/UTC /etc/localtime
  echo "UTC" > /etc/timezone
fi

# If running as root, drop to node user
if [ "$(id -u)" = "0" ]; then
  exec gosu node "$@"
fi

# Otherwise just run command
exec "$@"