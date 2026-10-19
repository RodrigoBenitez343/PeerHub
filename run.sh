#!/bin/sh
# Launch Ghost Drive from this folder. A second launch is refused while the
# first one holds .app-instance.lock, so instances never stack - the lock is
# released by the kernel when the process exits, even after a hard kill.
# Optional args replace the default command, e.g. "./run.sh npm run build".

set -eu

cd "$(dirname "$0")"

if command -v flock >/dev/null 2>&1; then
	exec 9>.app-instance.lock
	if ! flock -n 9; then
		echo "[ghost-drive] already running - close the existing window first." >&2
		exit 1
	fi
else
	# No flock on this box: fall back to a pid file.
	LOCK=.app-instance.pid
	if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK")" 2>/dev/null; then
		echo "[ghost-drive] already running (pid $(cat "$LOCK")) - close the existing window first." >&2
		exit 1
	fi
	echo $$ >"$LOCK"
	trap 'rm -f "$LOCK"' EXIT INT TERM
fi

if [ ! -d node_modules ]; then
	echo "[ghost-drive] node_modules missing, installing dependencies ..."
	npm install
fi

if [ "$#" -eq 0 ]; then
	set -- npm run dev -- --port 5173 --strictPort
fi

exec "$@"
