#!/bin/bash
# Remove the Iris auto-start LaunchAgent installed by install-autostart.sh.
set -euo pipefail
LABEL="com.iris.dashboard"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "Iris auto-start removed. (Any running instance has been stopped.)"
