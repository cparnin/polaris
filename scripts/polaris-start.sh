#!/bin/bash
# Launch wrapper for Polaris, used by the macOS LaunchAgent
# (~/Library/LaunchAgents/com.polaris.dashboard.plist) so it auto-starts at login.
#
# Runs the LEAN PRODUCTION build: one Node process serving both the API and the
# compiled dashboard on http://127.0.0.1:4000 - no Vite dev server, no bundler,
# no file-watchers (~80MB instead of ~200MB). launchd gives us a minimal
# environment, so set an explicit PATH for Homebrew node/npm first.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$(dirname "$0")/.." || exit 1

# Don't run a second copy on top of the one launchd already has. Without this,
# running this script by hand while the service is up dumps a raw EADDRINUSE
# stack trace, which reads like a crash when it's really "already running".
if curl -sf -o /dev/null --max-time 3 http://127.0.0.1:4000/api/health; then
  echo "Polaris is already running → http://127.0.0.1:4000"
  echo "This script is the launchd wrapper; you don't need to run it by hand."
  echo "Use: ./polaris {status|stop|restart|logs}"
  exit 0
fi

# Build once if the compiled output is missing (first run, or after a clean).
# When you change the code, run `npm run build` to refresh it.
if [ ! -f server/dist/index.js ] || [ ! -f web/dist/index.html ]; then
  npm run build || exit 1
fi

# exec Node directly (not `npm start`) so the running service is a SINGLE ~80MB
# process - `npm start` would leave two extra npm wrapper shells resident.
exec node server/dist/index.js
