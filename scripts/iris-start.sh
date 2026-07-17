#!/bin/bash
# Launch wrapper for the Iris dashboard, used by the macOS LaunchAgent
# (~/Library/LaunchAgents/com.iris.dashboard.plist) so it auto-starts at login.
# launchd runs with a minimal environment, so set an explicit PATH for Homebrew
# node/npm and cd into the repo before starting the dev servers.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$(dirname "$0")/.." || exit 1
exec npm run dev
