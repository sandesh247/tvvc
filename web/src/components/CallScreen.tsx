import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Phone, PhoneOff } from 'lucide-react';
import { httpsCallable } from 'firebase/functions';
import type { User } from '../App';
import { db, functions } from '../firebase';
import {
  collection, doc, getDoc, onSnapshot, updateDoc,
  addDoc, deleteDoc, getDocs, serverTimestamp, runTransaction
} from 'firebase/firestore';

interface CallScreenProps {
  currentUser: User;
  remoteUserId: string;
  isIncoming: boolean;
  onEndCall: () => void;
}

export default function CallScreen({ currentUser, remoteUserId, isIncoming, onEndCall }: CallScreenProps) {
  const [callState, setCallState] = useState<'ringing' | 'connected'>(isIncoming ? 'ringing' : 'connected');

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const pc = useRef<RTCPeerConnection | null>(null);
  const localStream = useRef<MediaStream | null>(null);
  const remoteStream = useRef<MediaStream | null>(null);
  const unsubscribes = useRef<(() => void)[]>([]);
  const isHangingUp = useRef(false);

  const callDocId = currentUser.id < remoteUserId ? `${currentUser.id}_${remoteUserId}` : `${remoteUserId}_${currentUser.id}`;

  // Memoize the Firestore document reference — it never changes for the life of this call.
  const callDoc = useMemo(() => doc(db, 'calls', callDocId), [callDocId]);

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

  const hangup = useCallback(async () => {
    if (isHangingUp.current) return;
    isHangingUp.current = true;

    // Clean up Firestore listeners
    unsubscribes.current.forEach(fn => fn());
    unsubscribes.current = [];

    if (pc.current) {
      pc.current.close();
    }
    if (localStream.current) {
      localStream.current.getTracks().forEach(track => track.stop());
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

  const answerCall = useCallback(async () => {
    if (!pc.current) return;

    const callSnapshot = await getDoc(callDoc);
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
      if (event.candidate) {
        addDoc(answerCandidates, event.candidate.toJSON());
      }
    };

    const offerDescription = callData.offer;
    await pc.current.setRemoteDescription(new RTCSessionDescription(offerDescription));

    const answerDescription = await pc.current.createAnswer();
    await pc.current.setLocalDescription(answerDescription);

    const answer = {
      type: answerDescription.type,
      sdp: answerDescription.sdp,
    };

    await updateDoc(callDoc, { answer, status: 'connected' });

    const unsub = onSnapshot(offerCandidates, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
          const candidate = new RTCIceCandidate(change.doc.data());
          pc.current?.addIceCandidate(candidate);
        }
      });
    });
    unsubscribes.current.push(unsub);

    // Listen for call document deletion (caller hung up)
    const unsubDoc = onSnapshot(callDoc, (snapshot) => {
      if (!snapshot.exists()) {
        console.log('Call ended by remote side.');
        hangup();
      }
    });
    unsubscribes.current.push(unsubDoc);
  }, [callDoc, hangup]);

  const startCall = useCallback(async () => {
    if (!pc.current) return;
    const offerCandidates = collection(callDoc, 'offerCandidates');
    const answerCandidates = collection(callDoc, 'answerCandidates');

    // Use a transaction to safely handle simultaneous outgoing call attempts
    let callDataToAnswer = null;
    try {
      await runTransaction(db, async (transaction) => {
        const docSnapshot = await transaction.get(callDoc);
        if (docSnapshot.exists()) {
          const data = docSnapshot.data();
          // Filter stale calls: ignore if document is older than 30 seconds
          const createdAt = data?.createdAt?.toDate?.();
          const isStale = createdAt && (Date.now() - createdAt.getTime() > 30000);

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
    }

    if (callDataToAnswer) {
      console.log('Mutual call detected: remote user called first. Answering their call instead.');
      await answerCall();
      return;
    }

    // Get candidates for caller, save to db
    pc.current.onicecandidate = (event) => {
      if (event.candidate) {
        addDoc(offerCandidates, event.candidate.toJSON());
      }
    };

    // Create offer
    const offerDescription = await pc.current.createOffer();
    await pc.current.setLocalDescription(offerDescription);

    const offer = {
      sdp: offerDescription.sdp,
      type: offerDescription.type,
    };

    await updateDoc(callDoc, { offer, status: 'ringing' });

    // Listen for remote answer
    const unsub1 = onSnapshot(callDoc, (snapshot) => {
      if (!snapshot.exists()) {
        console.log('Call ended by remote side.');
        hangup();
        return;
      }
      const data = snapshot.data();
      if (!pc.current?.currentRemoteDescription && data?.answer) {
        const answerDescription = new RTCSessionDescription(data.answer);
        pc.current?.setRemoteDescription(answerDescription);
      }
    });
    unsubscribes.current.push(unsub1);

    // Listen for remote ICE candidates
    const unsub2 = onSnapshot(answerCandidates, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
          const candidate = new RTCIceCandidate(change.doc.data());
          pc.current?.addIceCandidate(candidate);
        }
      });
    });
    unsubscribes.current.push(unsub2);
  }, [callDoc, hangup, answerCall, currentUser.id, remoteUserId]);


  useEffect(() => {
    const setupWebRTC = async () => {
      // Fetch TURN credentials from Cloud Function
      let iceServers: RTCIceServer[] = [
        { urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
      ];

      try {
        const getTurnCreds = httpsCallable(functions, 'getTurnCredentials');
        const result = await getTurnCreds();
        const data = result.data as { iceServers: RTCIceServer[] };
        if (data.iceServers) {
          iceServers = data.iceServers;
        }
      } catch (err) {
        console.warn('Failed to fetch TURN credentials, using STUN only:', err);
      }

      // iceCandidatePoolSize: 2 is plenty for a home LAN; the default tutorial
      // value of 10 generates unnecessary STUN traffic.
      pc.current = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 2 });

      // Setup media streams
      remoteStream.current = new MediaStream();
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remoteStream.current;
      }

      try {
        localStream.current = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = localStream.current;
        }

        localStream.current.getTracks().forEach((track) => {
          pc.current?.addTrack(track, localStream.current!);
        });
      } catch (err) {
        console.error('Failed to get local stream', err);
      }

      pc.current.ontrack = (event) => {
        event.streams[0].getTracks().forEach((track) => {
          remoteStream.current?.addTrack(track);
        });
      };

      if (!isIncoming) {
        startCall();
      }
    };

    setupWebRTC();

    return () => {
      hangup();
    };
  }, [isIncoming, startCall, hangup]);

  return (
    <div className="call-container">
      <video ref={remoteVideoRef} className="remote-video" autoPlay playsInline />
      <video ref={localVideoRef} className="local-video" autoPlay playsInline muted />

      {callState === 'ringing' && isIncoming && (
        <div className="incoming-overlay">
          <div className="caller-name">Incoming Call...</div>
          <div className="incoming-controls">
            <button className="control-btn end" onClick={hangup}>
              <PhoneOff size={40} />
            </button>
            <button className="control-btn answer" onClick={answerCall} autoFocus>
              <Phone size={40} />
            </button>
          </div>
        </div>
      )}

      {callState === 'connected' && (
        <div className="call-controls">
          <button className="control-btn end" onClick={hangup} autoFocus>
            <PhoneOff size={32} />
          </button>
        </div>
      )}
    </div>
  );
}
