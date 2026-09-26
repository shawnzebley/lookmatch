#!/bin/sh
# Serve web/ on :8765 for the duration of one command (used by the browser tests).
cd "$(dirname "$0")/.."
python3 -m http.server 8765 --directory web >/dev/null 2>&1 &
PID=$!
sleep 1
"$@"; CODE=$?
kill $PID 2>/dev/null
exit $CODE
