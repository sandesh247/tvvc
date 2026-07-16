# Session Summary - 2026-07-15

## Initial Goal
Design and implement Adaptive Audio Ducking with a toggle control in the React calling UI to mitigate audio feedback/echo on TV devices.

## Design Choices Considered
1. **Push-to-Talk (PTT)**: Fully mute the local microphone unless a remote control key is pressed. While 100% effective against echo, it reduces natural conversational flow.
2. **Binary Voice Activity Detection (VAD) Muting**: Disable the local mic track when no local voice is detected. This leaves the room vulnerable to echo during active local-side speaking intervals.
3. **Adaptive Audio Ducking (Chosen)**: Use the Web Audio API to dynamically analyze remote audio levels and apply a gain reduction (-22dB) to the local microphone stream only when the remote caller is actively speaking.

## Design Choices Chosen
1. **Implemented Web Audio API dynamic gain control**: Created graph processing helpers (`processLocalStream` and `setupRemoteAnalyser`) to intercept local microphone input and measure remote audio output via `AnalyserNode`.
2. **Added requestAnimationFrame Volume Polling Loop**: Created an efficient periodic polling loop checking if remote volume exceeds a calibrated threshold. If exceeded, the local microphone gain is dynamically decayed (using `setTargetAtTime` with a 50ms time constant) to duck the echo.
3. **Persisted Ducking State**: Saved user toggles to `localStorage` under key `tvvc_ducking_enabled`, defaulting to `true` on Android TV platforms (`isTv`).
4. **Added call controls UI Toggle**: Implemented a toggle button in the connected call view using `Volume2` and `VolumeX` icons.
5. **Cleaned up Web Audio Graph**: Closed `AudioContext` and nullified reference arrays inside the `hangup` callback to avoid memory leakage.
