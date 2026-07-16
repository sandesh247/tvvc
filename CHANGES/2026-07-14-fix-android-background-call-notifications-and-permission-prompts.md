# Session Summary - 2026-07-14

**Commit ID**: `fcba2942ad6ad4d25a9af78dc4a36172f3e85479`

## Initial Goal
Fix background service start crashes on Android 14+ and eliminate repetitive settings overlay permission prompts.

## Design Choices Considered
1. **Native overlay drawing vs standard Call Notification channels**: Deciding the most robust way to prompt the user about an incoming call.

## Design Choices Chosen
1. **Wrapped `startForeground` in try-catch**: Fell back to a static `showFallbackCallNotification` method when standard start was restricted.
2. **Upgraded notification styling**: Migrated notification to `NotificationCompat.CallStyle` layout.
3. **Added settings dialog validation**: Added check on settings dialog intents inside `MainActivity` to prevent loops.
