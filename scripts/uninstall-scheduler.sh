#!/bin/bash
PLIST_PATH="$HOME/Library/LaunchAgents/ai.caldr.autonomous-agent.plist"
launchctl unload "$PLIST_PATH" 2>/dev/null
rm -f "$PLIST_PATH"
echo "✓ Scheduler removed"
