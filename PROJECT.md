# Project: TVVC Audit Remediation

## Architecture
TVVC is a cross-platform video calling application built with React (Web), Android (WebView wrapper with Native SDK features), and Firebase (Firestore, Auth, Messaging, Cloud Functions).
- **Web Frontend (`web/`)**: Handles UI, WebRTC connections, user listings, and authenticates using Firebase Auth via custom token.
- **Android Native App (`android/`)**: Wraps the Web frontend in a WebView, intercepts FCM background wake-up notifications to trigger incoming calls, routes audio to speakerphone, supports Picture-in-Picture, and interacts with web via an `AndroidBridge`.
- **Cloud Functions (`functions/`)**: Backend logic for custom token authentication (PIN verification), TURN credential relay, and maintenance background cron jobs (garbage collection).
- **Firestore Security Rules (`firestore.rules`)**: Controls access to call sessions, users metadata, and private secrets.

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Firestore Rules & Security | Fix F-01 (CEL matches), F-05 (private FCM token collection/rules) | None | DONE |
| 2 | Cloud Functions Backend | Fix F-02 (verifyPin TOCTOU), F-10 (Calls GC), F-19 (TURN cache DB first), F-20 (Coalesce TURN requests), F-21 (onCallCreated try/catch), F-22 (Users GC), F-26 (Pre-build cleanup) | M1 | DONE |
| 3 | React Web Frontend | Fix F-05 (secrets subcollection sync), F-06 (Session UUIDs), F-07 (startCall cancels), F-09 (Audio/Video toggles), F-11 (Ringing timeout), F-12 (queue addIceCandidate), F-14 (syncUid direct call), F-23 (FCM token injection), F-24 (Remove scroll lock), F-25 (Remove dead onAuthenticated prop) | M1, M2 | DONE |
| 4 | Android Native App | Fix F-03 (Foreground service catch/priority), F-04 (handleIncomingCallIntent JS bridge), F-08 (Remove cancel_call disruptive launch), F-13 (WebView memory leak/onDestroy), F-15 (AudioManager speakerphone), F-16 (TV Remote back button confirm), F-17 (Autofocus optional), F-18 (Picture-in-Picture support) | M3 | DONE |
| 5 | Integration & Verification | Refine JS-Native integration bridge and perform final compilation checks | M4 | DONE |
| 6 | Stable Device ID Integration | Implement stable native device identifier (Android's secure ANDROID_ID via AndroidBridge) in Android and Web apps, build both platforms | M5 | DONE |
| 7 | Background Call Reception & Token Cleanup | Immediate foreground service on FCM, unified notification with Answer/Decline, FCM TTL, and stale token GC in Functions | M6 | DONE |
| 8 | Firebase Error Logging | Configure Android Crashlytics, Web Firestore Logger, rules for /client_errors | M7 | DONE |

## Interface Contracts
### React Web ↔ Android Native Bridge
- **`window.AndroidBridge.syncUid(uid: string)`**: Synchronizes user ID to native side when auth state changes (no polling).
- **`window.AndroidBridge.getFcmToken()`**: Deprecated. Native app will inject FCM token directly.
- **`window.AndroidBridge.getDeviceId()`**: Returns the device's secure ANDROID_ID hex string, or falls back to a locally persisted UUID.
- **`window.AndroidBridge.logError(message: string, stackTrace: string)`**: Forwards a JavaScript exception from the WebView to native Firebase Crashlytics as a non-fatal error.
- **`window.handleFcmToken(token: string)`**: JS function invoked by native app when FCM token is registered or page loads.
- **`window.handleIncomingCallIntent(callId: string, callerId: string)`**: JS function invoked by native app when user clicks call notification while app is already running.

### React Web ↔ Cloud Functions (Callable)
- **`verifyPin({ pin: string, deviceId: string })`** -> `{ token: string }`
- **`getTurnCredentials()`** -> `{ iceServers: IceServer[] }`

### Firestore Data Schema
- `/users/{userId}`: Public user details (name, id, lastSeen).
- `/users/{userId}/private/secrets`: Owner-only private subcollection containing `fcmToken`.
- `/calls/{callId}`: WebRTC call document.
- `/calls/{callId}/callerCandidates/{candidateId}`: ICE candidates sent by caller.
- `/calls/{callId}/calleeCandidates/{candidateId}`: ICE candidates sent by callee.
- `/client_errors/{errorId}`: Publicly writeable (create-only) error log containing `message`, `stack`, `timestamp`, `userAgent`, and `appVersion`.
