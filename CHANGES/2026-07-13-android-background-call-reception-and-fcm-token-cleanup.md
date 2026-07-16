# Session Summary - 2026-07-13

**Commit ID**: `fd31a9d33d473b463b017cfe5a84d5382af87463`

## Initial Goal
Fix background incoming call reception crashes caused by starting foreground services while backgrounded (Android 12+ restriction), and clean up obsolete FCM push tokens.

## Design Choices Considered
1. **Starting foreground service vs direct notification manager posting**: Handling background service launch limitations on modern Android versions.
2. **Handshake protocol between native shell activity and WebView React app**: Deciding how to communicate app readiness status before launching intents.

## Design Choices Chosen
1. **Launched `CallNotificationService` as a foreground service from `onMessageReceived`**: Dispatched it directly from `MyFirebaseMessagingService.kt` to comply with service requirements.
2. **Built 'isAppReady' handshake in native activity**: WebView calls `window.AndroidBridge.onAppReady()` on mount, signaling native code to dispatch any deferred intents safely.
3. **Transactional token cleanup**: Updated Cloud Functions to use a transaction when cleaning up stale FCM tokens returned as unregistered by Google.
