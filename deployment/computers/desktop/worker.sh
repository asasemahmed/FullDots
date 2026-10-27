#!/bin/bash
set -eu
export HOME=/home/desktop USER=desktop DISPLAY=:0 PROFILES_DIR=/profiles/desktop-browser
export COMPUTER_TOKEN=desktop-internal-transport-only-0000
export COMPUTER_BROWSER_IDLE_MS=0 LANG=C.UTF-8
umask 000
if [ "${1:-}" != '--session' ]; then
  exec flock -n /tmp/fulldots-desktop-worker.lock dbus-run-session -- "$0" --session
fi
attempt=0
until curl --silent --output /dev/null --connect-timeout 1 http://127.0.0.1:4100/health; do
  attempt=$((attempt+1))
  if [ "$attempt" -gt 120 ]; then exit 1; fi
  sleep 0.25
done
rm -f -- /tmp/fulldots-desktop.sock /tmp/.X0-lock /tmp/.X11-unix/X0
bun /opt/desktop-service/src/index.ts >/tmp/desktop-api.log 2>&1 &
api=$!
desktop=''
trap 'kill "$api" ${desktop:+"$desktop"} 2>/dev/null || true; wait 2>/dev/null || true' EXIT
attempt=0
until xdpyinfo -display :0 >/dev/null 2>&1; do
  attempt=$((attempt+1))
  if [ "$attempt" -gt 120 ]; then exit 1; fi
  sleep 0.25
done
xfce4-session >/tmp/desktop-session.log 2>&1 &
desktop=$!
wait -n "$api" "$desktop"
