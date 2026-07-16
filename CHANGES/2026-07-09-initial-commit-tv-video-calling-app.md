# Session Summary - 2026-07-09

**Commit ID**: `0b3c93210eb506fcfb5ede265fce019fdd53aaaf`

## Initial Goal
Setup initial codebase and scaffold both web application (React, WebRTC, Firebase) and native Android wrapper.

## Design Choices Considered
1. **Pure web application hosted on TV browser vs. hybrid native wrapper containing a full-screen WebView**: Evaluating accessibility, performance, and ability to handle incoming push notifications.

## Design Choices Chosen
We chose **Hybrid Android wrapper WebView hosting React/Vite**. Implemented Firestore-based WebRTC signaling, remote D-Pad center key forwarding, permission handlers, and a silent FCM push receiver that requests a full wake lock to bring the app to the foreground.
