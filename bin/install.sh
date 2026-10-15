#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"
APP="$HOME/Applications/RoutineBar.app"
AGENTS="$HOME/Library/LaunchAgents"
DATA="$HOME/.routinebar"
NODE="$(command -v node)"
DOMAIN="gui/$(id -u)"

mkdir -p "$APP/Contents/MacOS" "$AGENTS" "$DATA"
swiftc -O -o "$APP/Contents/MacOS/RoutineBar" menubar/RoutineBar.swift
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>RoutineBar</string>
  <key>CFBundleIdentifier</key><string>com.routinebar.menubar</string>
  <key>CFBundleName</key><string>RoutineBar</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
</dict></plist>
PLIST

write_agent() {
  local label="$1" program="$2" log="$3"
  cat > "$AGENTS/$label.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array>$program</array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
</dict></plist>
PLIST
  launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$AGENTS/$label.plist"
}

write_agent com.routinebar.server "<string>$NODE</string><string>$REPO/src/server.mjs</string>" "$DATA/server.log"
write_agent com.routinebar.menubar "<string>$APP/Contents/MacOS/RoutineBar</string>" "$DATA/menubar.log"
echo "Installed. Dashboard: http://127.0.0.1:4141"
