# Session Summary - 2026-07-12

**Commit ID**: `7259cf51bb55006a40d3772d70042ae68180ec37`

## Initial Goal
Fix remote control keyboard focus bugs, Callee infinite ringing loops on bilateral cleanup, and introduce an incoming call ringtone.

## Design Choices Considered
1. **Constant presence polling vs. visibility-dependent client presence heartbeat**: Determining how to track user online status efficiently.
2. **Native Android ringtone vs. HTML5 Web Audio ringer**: Deciding where to play the incoming call ringtone.

## Design Choices Chosen
1. **Visibility-dependent Firestore client presence heartbeat**: Sends a `lastSeen` update every 60 seconds when the document is visible, and sets the state to offline immediately on page unload. Users are rendered online if `lastSeen` < 90s.
2. **Built `isHangingUp` ref**: Used a ref to guard against infinite teardown loops on bilateral document deletion during call cleanup.
3. **Added HTML5 Web Audio loop**: Initiated a loop inside `CallScreen.tsx` during the incoming ringing state.
4. **Configured native `MainActivity.kt` focus request**: Explicitly requested WebView focus (`webView.isFocusable = true` and `webView.requestFocus()`) to ensure the D-pad remote inputs register.
