#!/bin/bash
# Installs the Caldr autonomous agent as a macOS LaunchAgent.
# Runs at login AND at 8:30am daily.

PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/ai.caldr.autonomous-agent.plist"
LEDGER_DIR="$HOME/autonomous-ledger"
NODE=$(which node)
LOG="$LEDGER_DIR/scheduler.log"

mkdir -p "$PLIST_DIR"

cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.caldr.autonomous-agent</string>

  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$LEDGER_DIR/scripts/scheduler.js</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>ANTHROPIC_API_KEY</key>
    <string>${ANTHROPIC_API_KEY}</string>
    <key>HOME</key>
    <string>${HOME}</string>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>

  <!-- Run at login -->
  <key>RunAtLoad</key>
  <true/>

  <!-- Run daily at 8:30am -->
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>8</integer>
    <key>Minute</key>
    <integer>30</integer>
  </dict>

  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>

  <!-- Restart if it crashes -->
  <key>KeepAlive</key>
  <false/>
</dict>
</plist>
EOF

# Load it
launchctl unload "$PLIST_PATH" 2>/dev/null
launchctl load "$PLIST_PATH"

echo ""
echo "✓ Scheduler installed and active"
echo "  Runs at: login + 8:30am daily"
echo "  Projects: auto-selected from your ledger (outstanding tasks, local path set)"
echo "  Log: $LOG"
echo ""
echo "  To check status: launchctl list | grep caldr"
echo "  To uninstall:    bash ~/autonomous-ledger/scripts/uninstall-scheduler.sh"
