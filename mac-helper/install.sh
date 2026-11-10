#!/bin/bash
# Installs (or updates) the Mac Mini stats helper so it runs at login.
# Run from anywhere:  bash ~/Documents/lcars-dashboard/mac-helper/install.sh
set -euo pipefail

DEST="$HOME/Library/Application Support/lcars-mac-helper"
PLIST="$HOME/Library/LaunchAgents/com.lcars.machelper.plist"
SRC="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$DEST"
cp "$SRC/stats_server.py" "$DEST/"
[ -x "$DEST/venv/bin/python" ] || /usr/bin/python3 -m venv "$DEST/venv"
"$DEST/venv/bin/pip" install -q --disable-pip-version-check psutil==6.1.1

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.lcars.machelper</string>
  <key>ProgramArguments</key>
  <array>
    <string>$DEST/venv/bin/python</string>
    <string>$DEST/stats_server.py</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>$DEST/helper.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/com.lcars.machelper" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Mac helper running on port 8089"
