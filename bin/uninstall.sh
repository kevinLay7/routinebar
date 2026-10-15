#!/bin/bash
set -uo pipefail
DOMAIN="gui/$(id -u)"
for label in com.routinebar.server com.routinebar.menubar; do
  launchctl bootout "$DOMAIN/$label" 2>/dev/null
  rm -f "$HOME/Library/LaunchAgents/$label.plist"
done
rm -rf "$HOME/Applications/RoutineBar.app"
echo "Uninstalled. Data left in ~/.routinebar."
