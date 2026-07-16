# Session Summary - 2026-07-12

**Commit ID**: `11d9c76dff5fea032ad8159f3b78a9bc04c5749f`

## Initial Goal
Implement App-Visibility native bridge to update presence to offline instantly, and direct notification dispatch to bypass Android background service start restrictions.

## Design Choices Considered
1. **Background service start restrictions**: Complying with Android 12 background limitations vs posting direct notification alerts.

## Design Choices Chosen
1. **Native app lifecycle listeners**: Listened to `onResume`, `onPause`, and `onStop` to update user presence immediately via Javascript window hooks.
2. **Direct notification post**: Posted incoming call notifications directly from `MyFirebaseMessagingService` with autoAnswer intent extras.
