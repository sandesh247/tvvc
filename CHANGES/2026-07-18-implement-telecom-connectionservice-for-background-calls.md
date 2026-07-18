# Session Summary - 2026-07-18

## Initial Goal
Diagnose and fix why the Android video calling app does not receive calls when the app is in the background or swiped away, despite being coded to handle this.

## Design Choices Considered
1. **Fix the existing foreground service approach**: Patch the `startForeground()` call to use a different `foregroundServiceType` or work around the `PhoneAccount` requirement. This was rejected because it treats the symptom, not the root cause, and doesn't give us system-level calling app privileges.
2. **Implement `ConnectionService` with `CAPABILITY_SELF_MANAGED`**: Register with Android's TelecomManager as a self-managed calling app. This was chosen because it's the official Android API for VoIP apps, eliminates foreground service start restrictions, keeps the process alive during ringing, and provides automatic Bluetooth/DND/lock screen integration.

## Design Choices Chosen
1. **Root cause identified**: `startForeground(FOREGROUND_SERVICE_TYPE_PHONE_CALL)` fails because the app declares `MANAGE_OWN_CALLS` but never registers a `PhoneAccount` with `TelecomManager`. Android 14+ (targetSdk 36) requires a registered `PhoneAccount` for this foreground service type.
2. **Implemented `ConnectionService` architecture**: Created `CallConnection.kt` and `CallConnectionService.kt` to handle incoming calls through `TelecomManager.addNewIncomingCall()` instead of starting a foreground service.
3. **Kept legacy fallback**: Preserved `showFallbackCallNotification()` for API < 26 devices or if `TelecomManager` fails unexpectedly.
4. **Integrated Connection lifecycle**: Updated `CallActionReceiver`, `MainActivity` JS bridge methods (`cancelIncomingCallNotification`, `setCallActive`), and intent handling to properly manage `Connection` state (ringing → active → disconnected).
