import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Phone, PhoneOff, Mic, MicOff, Video, VideoOff } from 'lucide-react';
import { httpsCallable } from 'firebase/functions';
import type { User } from '../App';
import { db, functions } from '../firebase';
import {
  collection, doc, getDoc, onSnapshot, updateDoc,
  deleteDoc, getDocs, serverTimestamp, runTransaction,
  writeBatch
} from 'firebase/firestore';

const adjustSdp = (sdp: string): string => {
  const lines = sdp.split(/\r?\n/);
  
  // 1. Identify dynamic payload type of Opus from the rtpmap line: a=rtpmap:<pt> opus/48000/2
  let opusPt: string | null = null;
  for (const line of lines) {
    if (line.toLowerCase().includes('a=rtpmap:') && line.toLowerCase().includes('opus/48000')) {
      const match = line.match(/a=rtpmap:(\d+)/i);
      if (match) {
        opusPt = match[1];
        break;
      }
    }
  }

  let inAudioSection = false;
  let ptimeAdded = false;
  let fmtpLineModifiedOrAdded = false;
  
  const processedLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace('\r', '');

    // Track if we are inside the audio section
    if (line.startsWith('m=')) {
      // If we were in the audio section and haven't added ptime:10, add it before leaving the section
      if (inAudioSection && !ptimeAdded) {
        processedLines.push('a=ptime:10');
        ptimeAdded = true;
      }

      if (line.startsWith('m=audio')) {
        inAudioSection = true;
        ptimeAdded = false;
      } else {
        inAudioSection = false;
      }
    }

    // Skip any existing a=ptime: lines in the audio section to prevent duplication
    if (inAudioSection && line.startsWith('a=ptime:')) {
      continue;
    }

    // If we have identified the Opus payload type, check for its fmtp line.
    // Use trailing space to avoid prefix matching bugs (e.g. Pt 11 matching 111).
    if (opusPt && line.startsWith(`a=fmtp:${opusPt} `)) {
      fmtpLineModifiedOrAdded = true;
      
      const prefix = `a=fmtp:${opusPt} `;
      const paramStr = line.substring(prefix.length).trim();
      const paramsList = paramStr.split(';').map(p => p.trim()).filter(Boolean);
      
      const paramMap: { [key: string]: string } = {};
      paramsList.forEach(p => {
        const parts = p.split('=');
        if (parts.length >= 2) {
          paramMap[parts[0].trim()] = parts.slice(1).join('=').trim();
        } else {
          paramMap[parts[0].trim()] = '';
        }
      });

      // Force our low-latency and mono configurations
      paramMap['useinbandfec'] = '1';
      paramMap['stereo'] = '0';
      paramMap['sprop-stereo'] = '0';
      paramMap['ptime'] = '10';
      paramMap['minptime'] = '10';
      paramMap['maxaveragebitrate'] = '20000';

      // Reconstruct the fmtp line
      const newParamStr = Object.keys(paramMap).map(key => {
        return paramMap[key] ? `${key}=${paramMap[key]}` : key;
      }).join(';');

      processedLines.push(`${prefix}${newParamStr}`);
      continue;
    }

    processedLines.push(line);
  }

  // If we reach the end of the SDP and are still in the audio section, append ptime:10
  if (inAudioSection && !ptimeAdded) {
    processedLines.push('a=ptime:10');
    ptimeAdded = true;
  }

  // If no fmtp line existed for Opus in the SDP but we found the Opus payload type,
  // we must create it and append it inside the audio section.
  if (opusPt && !fmtpLineModifiedOrAdded) {
    let inserted = false;
    const finalLines: string[] = [];
    for (const line of processedLines) {
      finalLines.push(line);
      // Use trailing space to prevent matching wrong PTs
      if (line.startsWith(`a=rtpmap:${opusPt} `) && !inserted) {
        finalLines.push(`a=fmtp:${opusPt} useinbandfec=1;stereo=0;sprop-stereo=0;ptime=10;minptime=10;maxaveragebitrate=20000`);
        inserted = true;
      }
    }
    return finalLines.join('\r\n');
  }

  return processedLines.join('\r\n');
}

const getMediaConstraints = (isTv: boolean) => ({
  video: isTv ? {
    width: { ideal: 640, max: 960 },
    height: { ideal: 360, max: 540 },
    frameRate: { ideal: 15, max: 20 }
  } : {
    width: { ideal: 640, max: 1280 },
    height: { ideal: 480, max: 720 },
    frameRate: { ideal: 24, max: 24 }
  },
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: { ideal: 1 }
  }
});

const applyVideoBitrateLimit = async (sender: RTCRtpSender) => {
  try {
    const parameters = sender.getParameters();
    if (!parameters.encodings || parameters.encodings.length === 0) {
      parameters.encodings = [{}];
    }
    parameters.encodings[0].maxBitrate = 800000; // 800 kbps
    await sender.setParameters(parameters);
    console.log('Video bitrate limit of 800kbps applied successfully.');
  } catch (err) {
    console.warn('Failed to apply video bitrate limit:', err);
  }
};

interface CallScreenProps {
  currentUser: User;
  remoteUserId: string;
  isIncoming: boolean;
  callId: string;
  onEndCall: () => void;
  autoAnswer?: boolean;
  preFetchedIceServers?: RTCIceServer[] | null;
}

export default function CallScreen({ currentUser, remoteUserId, isIncoming, callId, onEndCall, autoAnswer, preFetchedIceServers }: CallScreenProps) {
  const [callState, setCallState] = useState<'ringing' | 'connected'>('ringing');
  const [remoteUserName, setRemoteUserName] = useState<string>('Unknown');
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [calleeUnavailable, setCalleeUnavailable] = useState(false);
  const [isWebRTCReady, setIsWebRTCReady] = useState(false);
  const actionButtonRef = useRef<HTMLButtonElement>(null);

  // TV Environment and dynamic constraints detection
  const isTv = useMemo(() => {
    return window.AndroidBridge?.isTvDevice ? window.AndroidBridge.isTvDevice() : false;
  }, []);

  const dynamicMediaConstraints = useMemo(() => getMediaConstraints(isTv), [isTv]);

  // Keep ref of credentials in sync to prevent closure errors in async setupWebRTC
  const iceServersRef = useRef<RTCIceServer[] | null>(preFetchedIceServers || null);
  useEffect(() => {
    iceServersRef.current = preFetchedIceServers || null;
  }, [preFetchedIceServers]);

  // Refs for local candidate batching/coalescing
  const candidateQueue = useRef<any[]>([]);
  const batchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      actionButtonRef.current?.focus();
    }, 100);
    return () => clearTimeout(timer);
  }, [callState, isIncoming, isWebRTCReady]);

  // Fetch the remote user's display name
  useEffect(() => {
    getDoc(doc(db, 'users', remoteUserId)).then((docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        if (data && data.name) {
          setRemoteUserName(data.name);
        }
      }
    }).catch(err => console.error('Error fetching remote user profile:', err));
  }, [remoteUserId]);

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const pc = useRef<RTCPeerConnection | null>(null);
  const localStream = useRef<MediaStream | null>(null);
  const remoteStream = useRef<MediaStream | null>(null);
  const unsubscribes = useRef<(() => void)[]>([]);
  const isHangingUp = useRef(false);
  const isCancelled = useRef(false);

  const isRemoteDescriptionSet = useRef(false);
  const queuedCandidates = useRef<RTCIceCandidate[]>([]);
  const ringingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingAutoAnswer = useRef(false);

  const callDocId = callId;

  // Memoize the Firestore document reference — it never changes for the life of this call.
  const callDoc = useMemo(() => doc(db, 'calls', callDocId), [callDocId]);

  const processCandidate = useCallback(async (candidate: RTCIceCandidate) => {
    try {
      if (pc.current) {
        await pc.current.addIceCandidate(candidate);
      }
    } catch (err) {
      console.error('Error adding ICE candidate:', err);
    }
  }, []);

  const addOrQueueCandidate = useCallback((candidate: RTCIceCandidate) => {
    if (isRemoteDescriptionSet.current) {
      processCandidate(candidate);
    } else {
      queuedCandidates.current.push(candidate);
    }
  }, [processCandidate]);

  const flushQueuedCandidates = useCallback(() => {
    isRemoteDescriptionSet.current = true;
    queuedCandidates.current.forEach((candidate) => {
      processCandidate(candidate);
    });
    queuedCandidates.current = [];
  }, [processCandidate]);

  const toggleMute = useCallback(() => {
    if (localStream.current) {
      localStream.current.getAudioTracks().forEach((track) => {
        track.enabled = !track.enabled;
      });
      setIsMuted(prev => !prev);
    }
  }, []);

  const toggleVideo = useCallback(() => {
    if (localStream.current) {
      localStream.current.getVideoTracks().forEach((track) => {
        track.enabled = !track.enabled;
      });
      setIsVideoOff(prev => !prev);
    }
  }, []);

  // Sync calling notifications to the native Android app container
  useEffect(() => {
    if (isIncoming) {
      if (callState === 'ringing') {
        if (window.AndroidBridge?.onIncomingCallReceived) {
          window.AndroidBridge.onIncomingCallReceived(callDocId, remoteUserId, remoteUserName);
        }
      } else {
        if (window.AndroidBridge?.cancelIncomingCallNotification) {
          window.AndroidBridge.cancelIncomingCallNotification();
        }
      }
    }
    return () => {
      if (window.AndroidBridge?.cancelIncomingCallNotification) {
        window.AndroidBridge.cancelIncomingCallNotification();
      }
    };
  }, [isIncoming, callDocId, remoteUserId, remoteUserName, callState]);

  // Play ringtone for incoming calls
  useEffect(() => {
    let audio: HTMLAudioElement | null = null;

    if (isIncoming && callState === 'ringing') {
      audio = new Audio('/ringtone.mp3');
      audio.loop = true;
      audio.play().catch((err) => {
        console.warn('Audio play failed:', err);
      });
    }

    return () => {
      if (audio) {
        audio.pause();
        audio.src = '';
      }
    };
  }, [isIncoming, callState]);

  const flushIceCandidates = useCallback(async (collectionRef: any) => {
    if (candidateQueue.current.length === 0) return;
    const candidatesToFlush = [...candidateQueue.current];
    candidateQueue.current = [];

    const batch = writeBatch(db);
    candidatesToFlush.forEach((candidate) => {
      const candidateDoc = doc(collectionRef);
      batch.set(candidateDoc, candidate);
    });

    try {
      await batch.commit();
      console.log(`Successfully committed batch of ${candidatesToFlush.length} ICE candidates.`);
    } catch (err) {
      console.error('Failed to commit ICE candidates batch:', err);
    }
  }, []);

  const queueIceCandidate = useCallback((collectionRef: any, candidate: any) => {
    candidateQueue.current.push(candidate);
    if (!batchTimer.current) {
      batchTimer.current = setTimeout(() => {
        batchTimer.current = null;
        flushIceCandidates(collectionRef);
      }, 500); // 500ms delay to batch candidates
    }
  }, [flushIceCandidates]);

  const hangup = useCallback(async () => {
    isCancelled.current = true;
    if (ringingTimeoutRef.current) {
      clearTimeout(ringingTimeoutRef.current);
      ringingTimeoutRef.current = null;
    }
    isRemoteDescriptionSet.current = false;
    queuedCandidates.current = [];

    // Clear ICE candidate batch timer and queue
    if (batchTimer.current) {
      clearTimeout(batchTimer.current);
      batchTimer.current = null;
    }
    candidateQueue.current = [];

    if (isHangingUp.current) return;
    isHangingUp.current = true;

    // Clean up Firestore listeners
    unsubscribes.current.forEach(fn => fn());
    unsubscribes.current = [];

    if (pc.current) {
      pc.current.close();
      pc.current = null;
    }
    if (localStream.current) {
      localStream.current.getTracks().forEach(track => track.stop());
      localStream.current = null;
    }
    if (remoteStream.current) {
      remoteStream.current.getTracks().forEach(track => track.stop());
      remoteStream.current = null;
    }
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }

    // Clean up the call document and its ICE candidate subcollections.
    // Firestore does not recursively delete subcollections, so we do it manually.
    // Both peers may attempt this concurrently; deleteDoc on a missing doc is a no-op.
    try {
      const offerCandidates = collection(callDoc, 'offerCandidates');
      const answerCandidates = collection(callDoc, 'answerCandidates');
      const [offerSnap, answerSnap] = await Promise.all([
        getDocs(offerCandidates),
        getDocs(answerCandidates),
      ]);
      await Promise.all([
        ...offerSnap.docs.map(d => deleteDoc(d.ref)),
        ...answerSnap.docs.map(d => deleteDoc(d.ref)),
      ]);
      await deleteDoc(callDoc);
    } catch (e) {
      console.error('Error cleaning up call document:', e);
    }

    onEndCall();
  }, [callDoc, onEndCall]);

  // Expose cancellation helper for native Foreground Service callback
  useEffect(() => {
    window.onCallCancelledBySystem = () => {
      console.log('Incoming call cancelled via native signal.');
      hangup();
    };
    return () => {
      window.onCallCancelledBySystem = undefined;
    };
  }, [hangup]);

  // Sync call state and hangUpCall registration with Android native bridge
  useEffect(() => {
    window.hangUpCall = hangup;
    window.AndroidBridge?.setCallActive?.(true);
    window.AndroidBridge?.setSpeakerphoneOn?.(true);

    return () => {
      window.hangUpCall = undefined;
      window.AndroidBridge?.setCallActive?.(false);
    };
  }, [hangup]);

  const answerCall = useCallback(async () => {
    if (!pc.current) {
      console.log('pc.current not ready, queueing answer');
      pendingAutoAnswer.current = true;
      return;
    }
    if (isCancelled.current) return;

    // Fix callee camera privacy leak: only request media stream and add tracks on explicit accept
    if (!localStream.current) {
      try {
        localStream.current = await navigator.mediaDevices.getUserMedia(dynamicMediaConstraints);
        if (isCancelled.current) {
          localStream.current.getTracks().forEach(track => track.stop());
          localStream.current = null;
          return;
        }
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = localStream.current;
        }

        localStream.current.getTracks().forEach((track) => {
          const sender = pc.current?.addTrack(track, localStream.current!);
          if (sender && track.kind === 'video') {
            applyVideoBitrateLimit(sender);
          }
        });
      } catch (err) {
        if (isCancelled.current) return;
        console.error('Failed to get local stream', err);
      }
    }

    const callSnapshot = await getDoc(callDoc);
    if (isCancelled.current) return;
    let callData = callSnapshot.data();
    if (!callData) {
      console.warn('Call document does not exist.');
      hangup();
      return;
    }

    // Wait for the offer to be ready if caller is still generating it
    if (!callData.offer) {
      console.log('Offer is not ready yet, waiting for it to be created...');
      callData = await new Promise((resolve) => {
        const unsubscribe = onSnapshot(callDoc, (snapshot) => {
          // Ignore transient cache snapshot showing document does not exist (from previous deletion).
          // Without this, the listener would resolve to null and abort the second call instantly.
          if (snapshot.metadata.fromCache && !snapshot.exists()) return;
          const data = snapshot.data();
          if (data && data.offer) {
            unsubscribe();
            resolve(data);
          } else if (!snapshot.exists()) {
            unsubscribe();
            resolve(null);
          }
        });
        // Timeout after 10 seconds
        setTimeout(() => {
          unsubscribe();
          resolve(null);
        }, 10000);
      }) as any;
      if (isCancelled.current) return;
    }

    if (!callData || !callData.offer) {
      console.warn('Failed to obtain a valid call offer.');
      hangup();
      return;
    }

    setCallState('connected');

    const offerCandidates = collection(callDoc, 'offerCandidates');
    const answerCandidates = collection(callDoc, 'answerCandidates');

    pc.current.onicecandidate = (event) => {
      if (isCancelled.current) return;
      if (event.candidate) {
        queueIceCandidate(answerCandidates, event.candidate.toJSON());
      } else {
        if (batchTimer.current) {
          clearTimeout(batchTimer.current);
          batchTimer.current = null;
        }
        flushIceCandidates(answerCandidates);
      }
    };

    const offerDescription = callData.offer;
    await pc.current.setRemoteDescription(new RTCSessionDescription(offerDescription));
    flushQueuedCandidates();
    if (isCancelled.current) return;

    const answerDescription = await pc.current.createAnswer();
    if (isCancelled.current) return;
    const modifiedSdp = answerDescription.sdp ? adjustSdp(answerDescription.sdp) : '';
    const modifiedAnswerDescription = new RTCSessionDescription({
      type: answerDescription.type,
      sdp: modifiedSdp,
    });
    await pc.current.setLocalDescription(modifiedAnswerDescription);
    if (isCancelled.current) return;

    const answer = {
      type: modifiedAnswerDescription.type,
      sdp: modifiedAnswerDescription.sdp,
    };

    await updateDoc(callDoc, { answer, status: 'connected' });
    if (isCancelled.current) return;

    const unsub = onSnapshot(offerCandidates, (snapshot) => {
      if (isCancelled.current) return;
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
          const candidate = new RTCIceCandidate(change.doc.data());
          addOrQueueCandidate(candidate);
        }
      });
    });
    unsubscribes.current.push(unsub);

  }, [callDoc, hangup, addOrQueueCandidate, flushQueuedCandidates, dynamicMediaConstraints, queueIceCandidate, flushIceCandidates]);

  useEffect(() => {
    if (isIncoming && callState === 'ringing') {
      if (autoAnswer || pendingAutoAnswer.current) {
        if (isWebRTCReady) {
          answerCall();
        }
      }
    }
  }, [isIncoming, callState, autoAnswer, answerCall, isWebRTCReady]);

  const startCall = useCallback(async () => {
    if (!pc.current) return;
    if (isCancelled.current) return;
    const offerCandidates = collection(callDoc, 'offerCandidates');
    const answerCandidates = collection(callDoc, 'answerCandidates');

    // Use a transaction to safely handle simultaneous outgoing call attempts
    let callDataToAnswer = null;
    try {
      await runTransaction(db, async (transaction) => {
        const docSnapshot = await transaction.get(callDoc);
        if (docSnapshot.exists()) {
          const data = docSnapshot.data();
          // Filter stale calls: ignore if document is older than 120 seconds
          const createdAt = data?.createdAt?.toDate?.();
          const isStale = createdAt && (Date.now() - createdAt.getTime() > 120000);

          if (!isStale && data && data.callerId === remoteUserId) {
            // The other user called us first. We should act as the callee.
            callDataToAnswer = data;
            return;
          }
        }

        // Otherwise, we claim the caller spot
        transaction.set(callDoc, {
          status: 'initiating',
          callerId: currentUser.id,
          calleeId: remoteUserId,
          createdAt: serverTimestamp()
        });
      });
    } catch (e) {
      console.error('Transaction failed while starting call:', e);
      hangup();
      return;
    }

    if (isCancelled.current) {
      if (!callDataToAnswer) {
        try { await deleteDoc(callDoc); } catch (err) { console.error(err); }
      }
      return;
    }

    if (callDataToAnswer) {
      console.log('Mutual call detected: remote user called first. Answering their call instead.');
      await answerCall();
      return;
    }

    // Get candidates for caller, save to db
    pc.current.onicecandidate = (event) => {
      if (isCancelled.current) return;
      if (event.candidate) {
        queueIceCandidate(offerCandidates, event.candidate.toJSON());
      } else {
        if (batchTimer.current) {
          clearTimeout(batchTimer.current);
          batchTimer.current = null;
        }
        flushIceCandidates(offerCandidates);
      }
    };

    // Create offer
    if (isCancelled.current) {
      try { await deleteDoc(callDoc); } catch (err) { console.error(err); }
      return;
    }
    const offerDescription = await pc.current.createOffer();
    if (isCancelled.current) {
      try { await deleteDoc(callDoc); } catch (err) { console.error(err); }
      return;
    }
    const modifiedSdp = offerDescription.sdp ? adjustSdp(offerDescription.sdp) : '';
    const modifiedOfferDescription = new RTCSessionDescription({
      type: offerDescription.type,
      sdp: modifiedSdp,
    });
    await pc.current.setLocalDescription(modifiedOfferDescription);
    if (isCancelled.current) {
      try { await deleteDoc(callDoc); } catch (err) { console.error(err); }
      return;
    }

    const offer = {
      sdp: modifiedOfferDescription.sdp,
      type: modifiedOfferDescription.type,
    };

    if (isCancelled.current) {
      try { await deleteDoc(callDoc); } catch (err) { console.error(err); }
      return;
    }
    await updateDoc(callDoc, { offer, status: 'ringing' });
    if (isCancelled.current) {
      try { await deleteDoc(callDoc); } catch (err) { console.error(err); }
      return;
    }

    // Start 30-second ringing timeout
    ringingTimeoutRef.current = setTimeout(async () => {
      setCalleeUnavailable(true);
      try {
        await deleteDoc(callDoc);
      } catch (err) {
        console.error('Error deleting call doc on ringing timeout:', err);
      }
      ringingTimeoutRef.current = setTimeout(() => {
        hangup();
      }, 3000);
    }, 30000);

    // Listen for remote answer
    let hasExisted = false;
    const unsub1 = onSnapshot(callDoc, async (snapshot) => {
      if (isCancelled.current) return;
      if (snapshot.exists()) {
        hasExisted = true;
      } else {
        // Only hang up if the document once existed and has now been deleted
        if (hasExisted && !snapshot.metadata.fromCache) {
          console.log('Call ended by remote side.');
          hangup();
          return;
        }
      }
      const data = snapshot.data();
      if (!pc.current?.currentRemoteDescription && data?.answer) {
        if (ringingTimeoutRef.current) {
          clearTimeout(ringingTimeoutRef.current);
          ringingTimeoutRef.current = null;
        }
        const answerDescription = new RTCSessionDescription(data.answer);
        try {
          await pc.current?.setRemoteDescription(answerDescription);
          flushQueuedCandidates();
        } catch (err) {
          console.error('Failed to set remote description on caller:', err);
        }
        setCallState('connected');
      }
    });
    unsubscribes.current.push(unsub1);

    // Listen for remote ICE candidates
    const unsub2 = onSnapshot(answerCandidates, (snapshot) => {
      if (isCancelled.current) return;
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
          const candidate = new RTCIceCandidate(change.doc.data());
          addOrQueueCandidate(candidate);
        }
      });
    });
    unsubscribes.current.push(unsub2);
  }, [callDoc, hangup, answerCall, currentUser.id, remoteUserId, addOrQueueCandidate, flushQueuedCandidates, queueIceCandidate, flushIceCandidates]);

  // Listen for call deletion / cancellation immediately for incoming calls
  useEffect(() => {
    if (isIncoming) {
      let hasExisted = false;
      const unsubDoc = onSnapshot(callDoc, (snapshot) => {
        if (isCancelled.current) return;
        if (snapshot.exists()) {
          hasExisted = true;
        } else {
          // Only hang up if the document once existed and has now been deleted
          if (hasExisted && !snapshot.metadata.fromCache) {
            console.log('Incoming call cancelled by caller.');
            hangup();
          }
        }
      });
      unsubscribes.current.push(unsubDoc);
    }
  }, [isIncoming, callDoc, hangup]);



  // Dynamically reconfigure peer connection if TURN credentials arrive mid-connection
  useEffect(() => {
    if (pc.current && preFetchedIceServers) {
      try {
        pc.current.setConfiguration({
          iceServers: preFetchedIceServers,
          iceCandidatePoolSize: 2
        });
        console.log('RTCPeerConnection configuration updated with late-arriving TURN credentials.');
      } catch (err) {
        console.warn('Failed to update RTCPeerConnection configuration:', err);
      }
    }
  }, [preFetchedIceServers]);

  useEffect(() => {
    isCancelled.current = false;

    const setupWebRTC = async () => {
      // Use pre-fetched TURN credentials if available, otherwise fall back to STUN and attempt to fetch them
      let iceServers: RTCIceServer[] = iceServersRef.current || [
        { urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
      ];

      if (!iceServersRef.current) {
        console.log('TURN credentials not pre-fetched, attempting to fetch now...');
        try {
          const getTurnCreds = httpsCallable(functions, 'getTurnCredentials');
          const result = await getTurnCreds();
          if (isCancelled.current) return;
          const data = result.data as { iceServers: RTCIceServer[] };
          if (data.iceServers) {
            iceServers = data.iceServers;
          }
        } catch (err) {
          if (isCancelled.current) return;
          console.warn('Failed to fetch TURN credentials on demand, using STUN only:', err);
        }
      }

      pc.current = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 2 });

      // Setup media streams
      remoteStream.current = new MediaStream();
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remoteStream.current;
      }

      pc.current.ontrack = (event) => {
        if (isCancelled.current) return;

        // Set playoutDelayHint to 0 on the RTCRtpReceiver to optimize the jitter buffer for low latency
        if (event.receiver) {
          const receiver = event.receiver as any;
          if ('playoutDelayHint' in receiver) {
            try {
              receiver.playoutDelayHint = 0;
              console.log('Set playoutDelayHint = 0 on RTCRtpReceiver for track:', event.track.id);
            } catch (err) {
              console.warn('Failed to set playoutDelayHint on RTCRtpReceiver:', err);
            }
          }
        }

        if (event.streams && event.streams[0]) {
          if (remoteVideoRef.current && remoteVideoRef.current.srcObject !== event.streams[0]) {
            remoteVideoRef.current.srcObject = event.streams[0];
          }
        } else {
          remoteStream.current?.addTrack(event.track);
          if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = remoteStream.current;
          }
        }
      };

      if (!isIncoming) {
        try {
          localStream.current = await navigator.mediaDevices.getUserMedia(dynamicMediaConstraints);
          if (isCancelled.current) {
            localStream.current.getTracks().forEach(track => track.stop());
            localStream.current = null;
            return;
          }
          if (localVideoRef.current) {
            localVideoRef.current.srcObject = localStream.current;
          }

          localStream.current.getTracks().forEach((track) => {
            const sender = pc.current?.addTrack(track, localStream.current!);
            if (sender && track.kind === 'video') {
              applyVideoBitrateLimit(sender);
            }
          });
        } catch (err) {
          if (isCancelled.current) return;
          console.error('Failed to get local stream', err);
        }

        await startCall();
      }

      setIsWebRTCReady(true);
    };

    setupWebRTC();

    return () => {
      isCancelled.current = true;
      if (ringingTimeoutRef.current) {
        clearTimeout(ringingTimeoutRef.current);
        ringingTimeoutRef.current = null;
      }
      hangup();
    };
  }, [isIncoming, startCall, hangup, dynamicMediaConstraints]);

  return (
    <div className="call-container">
      {calleeUnavailable && (
        <div className="unavailable-banner">
          Callee Unavailable
        </div>
      )}
      <video ref={remoteVideoRef} className="remote-video" autoPlay playsInline />
      <video ref={localVideoRef} className="local-video" autoPlay playsInline muted />

      {callState === 'ringing' && isIncoming && (
        <div className="incoming-overlay">
          <div className="caller-name">Incoming Call from {remoteUserName}...</div>
          <div className="incoming-controls">
            <button ref={actionButtonRef} className={`control-btn answer ${!isWebRTCReady ? 'disabled' : ''}`} onClick={answerCall} disabled={!isWebRTCReady} autoFocus>
              <Phone size={40} />
            </button>
            <button className="control-btn end" onClick={hangup}>
              <PhoneOff size={40} />
            </button>
          </div>
        </div>
      )}

      {callState === 'ringing' && !isIncoming && (
        <div className="incoming-overlay">
          <div className="caller-name">Calling {remoteUserName}...</div>
          <div className="incoming-controls">
            <button ref={actionButtonRef} className="control-btn end" onClick={hangup} autoFocus>
              <PhoneOff size={40} />
            </button>
          </div>
        </div>
      )}

      {callState === 'connected' && (
        <div className="call-controls">
          <button className={`control-btn toggle ${isMuted ? 'off' : ''}`} onClick={toggleMute}>
            {isMuted ? <MicOff size={32} /> : <Mic size={32} />}
          </button>
          <button className={`control-btn toggle ${isVideoOff ? 'off' : ''}`} onClick={toggleVideo}>
            {isVideoOff ? <VideoOff size={32} /> : <Video size={32} />}
          </button>
          <button ref={actionButtonRef} className="control-btn end" onClick={hangup} autoFocus>
            <PhoneOff size={32} />
          </button>
        </div>
      )}
    </div>
  );
}
