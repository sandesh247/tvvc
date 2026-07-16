# Session Summary - 2026-07-15

## Initial Goal
Reduce WebRTC TURN server relay usage and bandwidth consumption.

## Design Choices Considered
1. **Reduce resolution and frame rate**: Restricting incoming/outgoing camera captures.
2. **Cap video bitrate via `setParameters`**: Programmatically restricting output bandwidth of the video RTCRtpSender.
3. **Deploy self-hosted TURN (coturn)**: Transitioning off the third-party managed Metered.ca server completely.

## Design Choices Chosen
1. **Implemented client-side resolution, framerate, and bitrate caps**:
   - Configured `mediaConstraints` in [CallScreen.tsx](file:///Users/sandesh247/github/tvvc/tvvc/web/src/components/CallScreen.tsx) with `ideal: 640, max: 1280` width and `ideal: 480, max: 720` height, and `max: 24` FPS.
   - Programmatically limited outgoing video bitrate to `800 kbps` via the standard `RTCRtpSender.setParameters` API when local video tracks are added to the peer connection.
   - This approach is fully backward compatible, requires zero infrastructure changes, and instantly halves data usage for TURN relay calls.
