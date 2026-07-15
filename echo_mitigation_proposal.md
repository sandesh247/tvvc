# Architectural Design Proposal: Audio Echo Mitigation for Android TV

This document outlines the architectural design options and recommendations to mitigate acoustic echo when using the TVVC application on Android TV devices. 

---

## 1. Introduction / Context

Real-time video and audio communication (VoIP) on Smart TVs and TV boxes presents unique acoustic challenges compared to smartphones or personal computers. In a typical TVVC deployment:
1. **Acoustic Power and Coupling**: TV speakers are large and output high-volume audio, which vibrates through the room.
2. **Microphone Placement**: The local microphone is usually far from the user (e.g., embedded in a remote control, an external USB webcam, or a TV bezel) and is often physically close to the speakers or placed where it directly captures the speaker output.
3. **Hardware Constraints**: Unlike mobile devices designed for two-way handset calling, smart TV platforms and external USB microphones rarely feature calibrated hardware-based Acoustic Echo Cancellation (AEC) DSP chips. 

Without proper mitigations, the remote caller's audio projects from the TV speakers, travels across the room, gets picked up by the local microphone, and is transmitted back to the remote user. This creates a severe acoustic feedback loop (echo), rendering natural two-way conversation impossible.

---

## 2. Current Architecture & Root Cause Analysis

An analysis of the current implementation reveals three primary architectural flaws that prevent effective echo cancellation on Android TV platforms.

### A. Code Citations and Specific Locations

1. **Unconstrained Audio Capture (Web Frontend)**
   - **Location**: `web/src/components/CallScreen.tsx`
   - **Lines 242 and 571**:
     ```typescript
     localStream.current = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
     ```
   - **Flaw**: By requesting `{ audio: true }` instead of specifying explicit constraints, the underlying browser engine (Chromium WebView) is not instructed to initialize its WebRTC software-based Acoustic Echo Cancellation (AEC3), Noise Suppression (NS), or Automatic Gain Control (AGC) modules.

2. **Unconditional Speakerphone Routing (Android Native Bridge)**
   - **Location**: `web/src/components/CallScreen.tsx` (Line 223) calls the native bridge:
     ```typescript
     window.AndroidBridge?.setSpeakerphoneOn?.(true);
     ```
   - **Location**: `android/app/src/main/java/com/sandesh247/tvvc/MainActivity.kt` (Lines 353–362) implements this call:
     ```kotlin
     @android.webkit.JavascriptInterface
     fun setSpeakerphoneOn(on: Boolean) {
         val activity = activityRef.get() ?: return
         Log.d("TVVC", "setSpeakerphoneOn: $on")
         try {
             val audioManager = activity.getSystemService(android.content.Context.AUDIO_SERVICE) as android.media.AudioManager
             audioManager.isSpeakerphoneOn = on
         } catch (e: Exception) {
             Log.e("TVVC", "Error setting speakerphone state", e)
         }
     }
     ```
   - **Flaw**: On mobile devices, `isSpeakerphoneOn = true` routes audio away from the earpiece receiver to the main speaker. On Android TV devices, there is no earpiece. Forcing `isSpeakerphoneOn = true` disrupts the TV's audio Hardware Abstraction Layer (HAL) routing.

3. **Absence of Audio Focus Management (Android Native)**
   - **Location**: `android/app/src/main/java/com/sandesh247/tvvc/MainActivity.kt` (Lines 364–376) implements:
     ```kotlin
     @android.webkit.JavascriptInterface
     fun setCallActive(active: Boolean) {
         // ...
         try {
             val audioManager = activity.getSystemService(android.content.Context.AUDIO_SERVICE) as android.media.AudioManager
             audioManager.mode = if (active) android.media.AudioManager.MODE_IN_COMMUNICATION else android.media.AudioManager.MODE_NORMAL
         } catch (e: Exception) {
             Log.e("TVVC", "Error setting call active audio mode", e)
         }
     }
     ```
   - **Flaw**: While the app shifts the `AudioManager` mode to `MODE_IN_COMMUNICATION`, it never explicitly requests **Audio Focus** using `requestAudioFocus`.

### B. Root Causes of Acoustic Echo

* **Lack of WebRTC Software AEC Activation**: Omitting constraints in `getUserMedia` means Chromium bypasses WebRTC's internal software-based AEC3 filter. The WebView assumes the underlying Android system handles echo cancellation natively.
* **TV Hardware AEC Limitations**: Most Android TVs and external USB microphones lack hardware-level AEC. In the absence of native OS-level echo cancellation, the raw, uncancelled audio stream is sent directly to WebRTC.
* **Physical Coupling and Latency**: Large TV rooms introduce multi-path acoustic reflections (reverberation). Furthermore, latency is introduced when routing audio over HDMI to external soundbars/AV receivers. When audio playout is delayed, WebRTC's software AEC cannot align the speaker output reference with the microphone input, causing AEC algorithms to fail.
* **Audio Routing Disruption via Speakerphone HAL**: TVs do not conform to mobile telephony routing. Forcing `isSpeakerphoneOn = true` can bypass the TV's internal voice-processing pathways, disabling any manufacturer-provided DSP AEC algorithms and sending raw output directly to the speakers.

---

## 3. Conceptual Design Options

To mitigate the acoustic feedback loop, we propose three distinct mitigation approaches.

### Option 1: WebRTC/Software-Level AEC Tuning

This approach targets the web client. We force the Chromium WebView to activate its WebRTC software audio processing pipeline and adjust the Session Description Protocol (SDP) to optimize Opus for mono speech communication.

#### A. Web Audio Capture Constraints (`CallScreen.tsx`)
Replace unconstrained audio capture with explicit, browser-enforced processing parameters:

```typescript
const mediaConstraints = {
  video: true,
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1, // Force mono input capture to reduce AEC complexity
  }
};

// Application
localStream.current = await navigator.mediaDevices.getUserMedia(mediaConstraints);
```

#### B. SDP Modification for Opus Voice Optimization (`CallScreen.tsx`)
Forcing mono audio transmission prevents WebRTC from processing stereo channels, which significantly increases AEC alignment accuracy and reduces CPU usage on TV processors.

```typescript
// Helper to modify SDP payload
const adjustSdp = (sdp: string): string => {
  // Disable stereo and force mono (stereo=0) to simplify echo cancellation modeling
  let modifiedSdp = sdp.replace(/useinbandfec=1/g, 'useinbandfec=1;stereo=0;sprop-stereo=0');
  
  // Force voice mode and preferred audio packetization
  modifiedSdp = modifiedSdp.replace(/a=rtpmap:(\d+) opus\/48000\/2/g, 'a=rtpmap:$1 opus/48000/1');
  
  return modifiedSdp;
};

// When setting local description for offer
const offer = await pc.current.createOffer();
const modifiedOffer = new RTCSessionDescription({
  type: offer.type,
  sdp: adjustSdp(offer.sdp || '')
});
await pc.current.setLocalDescription(modifiedOffer);

// When setting local description for answer
const answer = await pc.current.createAnswer();
const modifiedAnswer = new RTCSessionDescription({
  type: answer.type,
  sdp: adjustSdp(answer.sdp || '')
});
await pc.current.setLocalDescription(modifiedAnswer);
```

---

### Option 2: Native Android Audio Routing & Focus Optimization

This approach fixes native system routing inside the Android container to ensure the OS recognizes the application as a voice communication stream, enabling native low-latency routing and hardware-assisted AEC where available.

#### A. TV Device Detection and Audio Focus Lifecycle Management (`MainActivity.kt`)
Add these helpers and lifecycle hooks inside `MainActivity.kt`:

```kotlin
private var audioFocusRequest: android.media.AudioFocusRequest? = null
private val audioFocusChangeListener = android.media.AudioManager.OnAudioFocusChangeListener { focusChange ->
    Log.d("TVVC", "Audio focus changed: $focusChange")
}

// Identify TV form-factors using UiModeManager
private fun isTvDevice(): Boolean {
    val uiModeManager = getSystemService(android.content.Context.UI_MODE_SERVICE) as android.app.UiModeManager
    return uiModeManager.currentModeType == android.content.res.Configuration.UI_MODE_TYPE_TELEVISION
}

private fun requestCallAudioFocus(audioManager: android.media.AudioManager) {
    try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val playbackAttributes = android.media.AudioAttributes.Builder()
                .setUsage(android.media.AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SPEECH)
                .build()
            
            audioFocusRequest = android.media.AudioFocusRequest.Builder(android.media.AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
                .setAudioAttributes(playbackAttributes)
                .setAcceptsDelayedFocusGain(false)
                .setOnAudioFocusChangeListener(audioFocusChangeListener)
                .build()
                
            audioFocusRequest?.let {
                val result = audioManager.requestAudioFocus(it)
                Log.d("TVVC", "Requested VOIP Audio Focus. Result code: $result")
            }
        } else {
            @Suppress("DEPRECATION")
            val result = audioManager.requestAudioFocus(
                audioFocusChangeListener,
                android.media.AudioManager.STREAM_VOICE_CALL,
                android.media.AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE
            )
            Log.d("TVVC", "Requested legacy Audio Focus. Result code: $result")
        }
    } catch (e: Exception) {
        Log.e("TVVC", "Failed to request Audio Focus", e)
    }
}

private fun abandonCallAudioFocus(audioManager: android.media.AudioManager) {
    try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            audioFocusRequest?.let {
                val result = audioManager.abandonAudioFocusRequest(it)
                Log.d("TVVC", "Abandoned VOIP Audio Focus. Result code: $result")
            }
            audioFocusRequest = null
        } else {
            @Suppress("DEPRECATION")
            val result = audioManager.abandonAudioFocus(audioFocusChangeListener)
            Log.d("TVVC", "Abandoned legacy Audio Focus. Result code: $result")
        }
    } catch (e: Exception) {
        Log.e("TVVC", "Failed to abandon Audio Focus", e)
    }
}
```

#### B. TV-Aware Speakerphone and Call Setup Bridge Calls (`MainActivity.kt`)
Update the Javascript Interface methods:

```kotlin
@android.webkit.JavascriptInterface
fun setSpeakerphoneOn(on: Boolean) {
    val activity = activityRef.get() ?: return
    
    // Skip speakerphone routing on Android TV to prevent breaking audio HAL pathways
    if (activity.isTvDevice()) {
        Log.d("TVVC", "setSpeakerphoneOn: Skipping routing change on Android TV device")
        return
    }
    
    Log.d("TVVC", "setSpeakerphoneOn: $on")
    try {
        val audioManager = activity.getSystemService(android.content.Context.AUDIO_SERVICE) as android.media.AudioManager
        audioManager.isSpeakerphoneOn = on
    } catch (e: Exception) {
        Log.e("TVVC", "Error setting speakerphone state", e)
    }
}

@android.webkit.JavascriptInterface
fun setCallActive(active: Boolean) {
    val activity = activityRef.get() ?: return
    activity.runOnUiThread {
        activity.isCallActive = active
    }
    
    try {
        val audioManager = activity.getSystemService(android.content.Context.AUDIO_SERVICE) as android.media.AudioManager
        if (active) {
            activity.requestCallAudioFocus(audioManager)
            audioManager.mode = android.media.AudioManager.MODE_IN_COMMUNICATION
        } else {
            audioManager.mode = android.media.AudioManager.MODE_NORMAL
            activity.abandonCallAudioFocus(audioManager)
        }
    } catch (e: Exception) {
        Log.e("TVVC", "Error modifying call active audio parameters", e)
    }
}
```

---

### Option 3: UX-Based Smart Voice-Activity / Soft Half-Duplex

When hardware AEC is physically bypassed and software AEC is overwhelmed by large speaker-to-microphone physical coupling, we can enforce a soft half-duplex mechanism. This limits the conversation so that local microphone transmission and remote speaker playback do not occur simultaneously. We present three implementation models:

#### Sub-Option A: Push-to-Talk (PTT)
Maps a remote D-pad button (e.g. `CENTER`/`OK` or a dedicated screen button) to toggle the microphone mute state. The mic is muted by default, eliminating feedback while listening.

```typescript
import React, { useState, useEffect } from 'react';

// Hook up Remote Control Key listener for D-pad center or Space
export const usePushToTalk = (localStream: React.MutableRefObject<MediaStream | null>) => {
  const [isMuted, setIsMuted] = useState(true);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ' || event.keyCode === 23) { // 23 is D-pad center on Android TV
        setMuteState(false);
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ' || event.keyCode === 23) {
        setMuteState(true);
      }
    };

    const setMuteState = (mute: boolean) => {
      if (localStream.current) {
        const audioTrack = localStream.current.getAudioTracks()[0];
        if (audioTrack) {
          audioTrack.enabled = !mute;
          setIsMuted(mute);
        }
      }
    };

    // Initialize as muted
    setMuteState(true);

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [localStream]);

  return isMuted;
};
```

#### Sub-Option B: Web Voice Activity Detection (VAD) Auto-Muting
Analyzes the local user's microphone volume. The local mic track is disabled when average volume drops below a noise threshold, preventing room echo from feeding back when the user is silent.

```typescript
export const startVoiceActivityDetection = (
  stream: MediaStream, 
  onSpeechChange: (isSpeaking: boolean) => void
) => {
  const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
  const audioContext = new AudioContextClass();
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);

  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  const speechThreshold = 35; // Calibrated voice threshold above background noise
  let isSpeaking = false;
  let silenceFrames = 0;

  const detect = () => {
    analyser.getByteFrequencyData(dataArray);
    const averageVolume = dataArray.reduce((sum, val) => sum + val, 0) / dataArray.length;

    if (averageVolume > speechThreshold) {
      silenceFrames = 0;
      if (!isSpeaking) {
        isSpeaking = true;
        onSpeechChange(true);
      }
    } else {
      silenceFrames++;
      // Require 15 consecutive frames (~300ms) of silence before muting to prevent clipping word endings
      if (silenceFrames > 15 && isSpeaking) {
        isSpeaking = false;
        onSpeechChange(false);
      }
    }
    requestAnimationFrame(detect);
  };

  detect();
  return () => {
    audioContext.close();
  };
};

// Usage inside CallScreen:
// useEffect(() => {
//   if (localStream.current) {
//     const audioTrack = localStream.current.getAudioTracks()[0];
//     const cleanup = startVoiceActivityDetection(localStream.current, (speaking) => {
//       if (audioTrack) audioTrack.enabled = speaking;
//     });
//     return cleanup;
//   }
// }, []);
```

#### Sub-Option C: Remote-Side Activity Driven Muting (Echo Suppression)
Monitors the audio level of the remote user's incoming stream. If the remote caller is speaking, the local microphone is automatically muted. When the remote caller stops, the local mic is unmuted.

```typescript
export const startEchoSuppressionThreshold = (
  remoteStream: MediaStream,
  localStream: MediaStream
) => {
  const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
  const audioContext = new AudioContextClass();
  const source = audioContext.createMediaStreamSource(remoteStream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);

  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  const remotePlaybackThreshold = 15; // Threshold indicating active remote speech
  const localAudioTrack = localStream.getAudioTracks()[0];

  const monitor = () => {
    analyser.getByteFrequencyData(dataArray);
    const remoteVolume = dataArray.reduce((sum, val) => sum + val, 0) / dataArray.length;

    if (localAudioTrack) {
      // Mute local mic if remote output exceeds threshold, else unmute
      localAudioTrack.enabled = remoteVolume <= remotePlaybackThreshold;
    }
    requestAnimationFrame(monitor);
  };

  monitor();
  return () => {
    audioContext.close();
  };
};
```

---

## 4. Structured Comparison

| Mitigation Option | Pros | Cons | Implementation Complexity | Expected Echo-Reduction Efficacy |
| :--- | :--- | :--- | :---: | :---: |
| **Option 1: WebRTC/Software-Level AEC Tuning** | - Zero user experience impact.<br>- Standard WebRTC compatibility.<br>- Minimal frontend lines of code. | - Highly dependent on WebView update versions.<br>- Clock drift on low-end TV chipsets causes filter mismatch.<br>- Adds processing latency. | **Low** | **Medium** |
| **Option 2: Native Android Audio Routing & Focus Optimization** | - Aligns Android OS audio policy correctly.<br>- Activates built-in hardware AEC path if supported by TV hardware.<br>- Prevents TV audio HAL crashes. | - TV audio driver support varies widely between vendors.<br>- Does not solve echo on TVs that lack physical AEC components. | **Medium** | **Medium to High** (on certified TV hardware) |
| **Option 3: UX-Based Smart Voice-Activity / Soft Half-Duplex** | - Guarantees 100% echo cancellation mathematically by blocking simultaneous IO paths.<br>- Works on all TV models. | - Restricts natural double-talk conversation flow.<br>- Requires button mapping or threshold parameter tuning. | **Medium to High** | **High** |

---

## 5. Architectural Recommendation

To ensure the highest quality experience across all Android TV models (from premium sets with dedicated hardware AEC to budget dongles using generic USB webcams), we recommend a **layered hybrid architecture**:

### 1. Phase 1 (Baseline Implementation) — Option 1 + Option 2
* **Actions**: Apply Option 1 (explicit media constraints and Mono SDP optimization) and Option 2 (Native Audio Focus, `MODE_IN_COMMUNICATION`, and TV-aware speakerphone bypass).
* **Rationale**: This establishes standard VoIP routing on the Android TV device. Skipping `isSpeakerphoneOn = true` allows the TV's audio HAL to route through its default voice channel. Concurrently, specifying `echoCancellation: true` ensures the Chromium engine initializes its AEC3 filter as a fallback when TV hardware processing is weak or absent.

### 2. Phase 2 (Fallback Protocol) — Option 3 (Sub-Option C + Sub-Option B)
* **Actions**: If testing indicates echo still leaks due to soundbar latency or clock drift, enable an **Adaptive Half-Duplex** mode in the React frontend.
* **Mechanism**: Use the Web Audio API to monitor remote playback levels (Option 3, Sub-Option C). When incoming audio is detected, automatically attenuate the local microphone gain or toggle `track.enabled = false`. If background room noise triggers false unmuting, supplement this with VAD gating (Option 3, Sub-Option B). 
* **Control UI**: Expose a setting in the app configuration menu ("Eco Audio / Half-Duplex Mode") that is automatically turned ON if the system detects it is running on a TV platform, allowing users to toggle it off if they use certified hardware speakerphones.
