# Session Summary - 2026-07-12

**Commit ID**: `47571988a67d89867cbf0e7c33d0e2f296df0f29`

## Initial Goal
Resolve all 21 bugs, leaks, and security vulnerabilities compiled during the codebase audit.

## Design Choices Considered
1. **Anonymous sign-in setup for Custom Token Auth**: Securing interactions with Firestore without requiring complex user credential flows.
2. **Metered.ca open relay dynamic credentials**: Provisioning TURN/STUN servers securely vs static hardcoding.
3. **Externalizing configuration parameters**: Making app parameters configurable without rebuilding code.
4. **Cleaning up unused modules**: Eliminating dead libraries/permissions.

## Design Choices Chosen
We implemented fixes in parallel commits:
1. **Created secure `verifyPin` Cloud Function** and built a TV-focused PinScreen.
2. **Secured Firestore rules** for `/users` and `/calls`.
3. **Exchanged TURN credentials** using custom token auth helper.
4. **Cleaned up boilerplate Compose dependencies**, react-router-dom, and dangerous unused permissions (e.g. `SYSTEM_ALERT_WINDOW`).
