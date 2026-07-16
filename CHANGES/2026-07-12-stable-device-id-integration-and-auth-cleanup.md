# Session Summary - 2026-07-12

**Commit ID**: `74bd60f51f55263650f3a0852caef0bfdf1297f1`

## Initial Goal
Generate stable device UIDs that survive app reinstalls and updates.

## Design Choices Considered
1. **Stable identification methods**: Advertising ID vs MAC address vs `Settings.Secure.ANDROID_ID`.

## Design Choices Chosen
We retrieved `ANDROID_ID`, filtered emulator constants (`9774d56d682e549c`), fell back to a generated UUID, and stored the value in `SharedPreferences`. We exposed this value via the bridge `getDeviceId()` to the WebView React app.
