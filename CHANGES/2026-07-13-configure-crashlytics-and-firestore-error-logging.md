# Session Summary - 2026-07-13

**Commit ID**: `f59d04795a4aa9dc2ed8973149e4564df1172eba`

## Initial Goal
Implement centralized logging for runtime errors across web and native clients.

## Design Choices Considered
1. **Write web errors directly to a Firestore collection vs. bridging web errors into native Crashlytics**: Weighing offline storage, severity tracking, and platform limits.

## Design Choices Chosen
We implemented both:
1. **Created `logger.ts` utility**: Writes standalone web errors to Firestore `/client_errors` collection (locked down as public-write-only).
2. **Exposed JS bridge interface `logError()` inside native MainActivity**: Records non-fatal exceptions in Firebase Crashlytics when running inside the WebView wrapper.
