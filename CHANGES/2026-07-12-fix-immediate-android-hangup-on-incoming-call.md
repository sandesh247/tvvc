# Session Summary - 2026-07-12

**Commit ID**: `7259cf51bb55006a40d3772d70042ae68180ec37`

## Initial Goal
Fix immediate hangup bug on Android when incoming calls are received.

## Design Choices Considered
1. **Firestore listener evaluations**: Resolving why the client-side presence listener immediately reads a cache-miss document deletion.

## Design Choices Chosen
We modified the snapshot listener in `CallNotificationService.kt`: added a `hasExisted` flag and checked `!snapshot.metadata.isFromCache` to ignore transient cache misses before shutting down the service.
