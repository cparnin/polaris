#!/bin/bash
# Install a macOS LaunchAgent so Iris auto-starts at login and restarts if it
# crashes. Paths are derived from this repo and $HOME, so nothing is hardcoded.
#   ./scripts/install-autostart.sh      (run once)
# Undo with ./scripts/uninstall-autostart.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.iris.dashboard"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$REPO/scripts/iris-start.sh</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$REPO</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>$HOME/Library/Logs/iris-dashboard.log</string>
    <key>StandardErrorPath</key>
    <string>$HOME/Library/Logs/iris-dashboard.err.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "Iris auto-start installed."
echo "  Dashboard:  http://localhost:5173"
echo "  Logs:       ~/Library/Logs/iris-dashboard.log"
echo "  Remove it:  ./scripts/uninstall-autostart.sh"
