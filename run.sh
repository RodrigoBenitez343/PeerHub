#!/bin/sh
# Launch Ghost Drive from this folder. A second launch is refused while the
# first one holds .app-instance.lock, so instances never stack - the lock is
# released by the kernel when the process exits, even after a hard kill.
# Optional args replace the default command, e.g. "./run.sh npm run build".
# GHOST_DRIVE_DEBUG=1 turns on shell tracing.

if [ "${GHOST_DRIVE_DEBUG:-0}" = "1" ]; then
	set -x
fi

set -eu

LOCK=

# A double-clicked terminal closes the moment this script exits, taking every
# error message with it, so a failed launch waits for Enter first.
cleanup() {
	code=$?
	if [ -n "$LOCK" ]; then
		rm -f "$LOCK"
	fi
	if [ "$code" -ne 0 ] && [ -t 0 ]; then
		printf '\n[ghost-drive] stopped with code %s. Press Enter to close ...' "$code"
		read -r _ || true
	fi
	exit "$code"
}
trap cleanup EXIT

cd "$(dirname "$0")"

# Desktop launchers do not read ~/.bashrc, so an nvm install is not on PATH.
if ! command -v npm >/dev/null 2>&1; then
	for dir in "${NVM_DIR:-$HOME/.nvm}/versions/node"/*/bin; do
		if [ -x "$dir/npm" ]; then
			PATH="$dir:$PATH"
		fi
	done
	export PATH
fi

if ! command -v npm >/dev/null 2>&1; then
	echo "[ghost-drive] npm not found on PATH." >&2
	echo "  Install Node.js, or start this from a terminal where npm works." >&2
	echo "  PATH is: $PATH" >&2
	exit 1
fi

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
fi

if [ ! -d node_modules ]; then
	echo "[ghost-drive] node_modules missing, installing dependencies ..."
	if ! npm install; then
		echo "[ghost-drive] npm install failed - see the error above." >&2
		exit 1
	fi
fi

if [ "$#" -eq 0 ]; then
	set -- npm run dev -- --port 5173 --strictPort
fi

exec "$@"
