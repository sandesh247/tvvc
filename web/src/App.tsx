import { useState, useEffect, useCallback, useRef } from 'react';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { auth, db, functions } from './firebase';
import PinScreen from './components/PinScreen';
import Registration from './components/Registration';
import ContactList from './components/ContactList';
import CallScreen from './components/CallScreen';
import { collection, onSnapshot, doc, setDoc, getDoc, serverTimestamp, query, where } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';

export interface User {
  id: string;
  name: string;
  lastSeen?: any; // Firestore Timestamp
  fcmToken?: string;
}

declare const __APP_VERSION__: string;

declare global {
  interface Window {
    handleFcmToken?: (token: string) => void;
    AndroidBridge?: {
      syncUid: (uid: string | null) => void;
      onIncomingCallReceived: (callId: string, callerId: string, callerName: string) => void;
      cancelIncomingCallNotification: () => void;
      setCallActive?: (active: boolean) => void;
      setSpeakerphoneOn?: (on: boolean) => void;
      getDeviceId?: () => string;
      getVersionName?: () => string;
      getFcmToken?: () => string | null;
      onAppReady?: () => void;
      logError?: (message: string, stackTrace: string) => void;
      requestOverlayPermission?: () => void;
      requestFullScreenIntentPermission?: () => void;
      requestIgnoreBatteryOptimizations?: () => void;
      isTvDevice?: () => boolean;
    };
    onCallCancelledBySystem?: () => void;
    handleIncomingCallIntent?: (callId: string, callerId: string, autoAnswer?: boolean) => void;
    hangUpCall?: () => void;
    onAppResume?: () => void;
    onAppPause?: () => void;
    onAppStop?: () => void;
  }
}

export function isVersionCompatible(clientVer: string, minVer: string): boolean {
  const parse = (v: string) => {
    const parts = v.split('.').map(Number);
    return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
  };
  const [cMajor, cMinor, cPatch] = parse(clientVer);
  const [mMajor, mMinor, mPatch] = parse(minVer);

  if (cMajor !== mMajor) {
    return cMajor > mMajor;
  }
  if (cMinor !== mMinor) {
    return cMinor > mMinor;
  }
  return cPatch >= mPatch;
}

function App() {
  const [authState, setAuthState] = useState<'loading' | 'unauthenticated' | 'authenticated'>('loading');
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [fcmToken, setFcmTokenState] = useState<string | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [activeCall, setActiveCall] = useState<{ remoteUserId: string; incoming: boolean; callId: string; autoAnswer?: boolean } | null>(null);
  const [preFetchedIceServers, setPreFetchedIceServers] = useState<RTCIceServer[] | null>(null);

  const activeCallRef = useRef(activeCall);
  useEffect(() => {
    activeCallRef.current = activeCall;
  }, [activeCall]);
  const [profileLoading, setProfileLoading] = useState<boolean>(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [versionState, setVersionState] = useState<'checking' | 'compatible' | 'blocked'>('checking');

  // Check version compatibility on mount
  useEffect(() => {
    const checkVersion = async () => {
      try {
        const getMinClientVersionFn = httpsCallable<unknown, { minClientVersion: string | null }>(
          functions,
          'getMinClientVersion'
        );
        const res = await getMinClientVersionFn();
        const minVer = res.data?.minClientVersion;
        if (minVer) {
          const clientVer = window.AndroidBridge?.getVersionName?.() || __APP_VERSION__;
          if (!isVersionCompatible(clientVer, minVer)) {
            const reloaded = sessionStorage.getItem('version_blocked_reloaded');
            if (!reloaded) {
              localStorage.clear();
              sessionStorage.clear();
              sessionStorage.setItem('version_blocked_reloaded', 'true');
              await signOut(auth);
              window.location.reload();
              return;
            } else {
              setVersionState('blocked');
              return;
            }
          }
        }
        setVersionState('compatible');
        sessionStorage.removeItem('version_blocked_reloaded');
      } catch (err) {
        console.error('Error checking version compatibility:', err);
        setVersionState('compatible');
      }
    };
    checkVersion();
  }, []);

  // Helper to load user profile from Firestore
  const loadUserProfile = useCallback(async (uid: string) => {
    setProfileLoading(true);
    setProfileError(null);
    try {
      const userDoc = await getDoc(doc(db, 'users', uid));
      if (userDoc.exists()) {
        setCurrentUser({ id: uid, ...userDoc.data() } as User);
      } else {
        setCurrentUser(null);
      }
    } catch (e: any) {
      console.error('Error loading user profile:', e);
      setProfileError(e.message || 'Failed to load user profile. Please check your connection and try again.');
    } finally {
      setProfileLoading(false);
    }
  }, []);

  const fetchTurnCredentials = useCallback(async () => {
    try {
      const getTurnCreds = httpsCallable(functions, 'getTurnCredentials');
      const result = await getTurnCreds();
      const data = result.data as { iceServers: RTCIceServer[] };
      if (data.iceServers) {
        setPreFetchedIceServers(data.iceServers);
        console.log('Pre-fetched TURN credentials successfully.');
      }
    } catch (err) {
      console.warn('Failed to pre-fetch TURN credentials:', err);
    }
  }, []);

  // Listen for Firebase Auth state changes
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        window.AndroidBridge?.syncUid(firebaseUser.uid);
        // User is authenticated — check if they have a Firestore profile
        await loadUserProfile(firebaseUser.uid);
        setAuthState('authenticated');
        fetchTurnCredentials();
      } else {
        window.AndroidBridge?.syncUid(null);
        setCurrentUser(null);
        setAuthState('unauthenticated');
        setProfileError(null);
        setProfileLoading(false);
        setPreFetchedIceServers(null);
      }
    });
    return () => unsubscribe();
  }, [loadUserProfile, fetchTurnCredentials]);

  // Request background execution permissions on Android when authenticated
  useEffect(() => {
    if (authState === 'authenticated' && window.AndroidBridge) {
      window.AndroidBridge.requestOverlayPermission?.();
      window.AndroidBridge.requestFullScreenIntentPermission?.();
      window.AndroidBridge.requestIgnoreBatteryOptimizations?.();
    }
  }, [authState]);

  const handleIncomingCall = useCallback((remoteUserId: string, callId: string, autoAnswer?: boolean) => {
    setActiveCall({ remoteUserId, incoming: true, callId, autoAnswer });
  }, []);

  // Expose global function for Android WebView FCM token injection.
  useEffect(() => {
    window.handleFcmToken = (token: string) => {
      console.log('Received FCM token from native app:', token);
      setFcmTokenState(token);
    };

    // Pull the token directly from the bridge if it's already available (resolving startup race conditions)
    if (window.AndroidBridge?.getFcmToken) {
      const token = window.AndroidBridge.getFcmToken();
      if (token) {
        console.log('Polled FCM token from native bridge on mount:', token);
        setFcmTokenState(token);
      }
    }

    window.handleIncomingCallIntent = (callId: string, callerId: string, autoAnswer?: boolean) => {
      const shouldAutoAnswer = autoAnswer === true || (autoAnswer as any) === 'true';
      handleIncomingCall(callerId, callId, shouldAutoAnswer);
    };

    window.AndroidBridge?.onAppReady?.();
  }, [handleIncomingCall]);

  // Sync FCM token to Firestore when it changes
  useEffect(() => {
    if (fcmToken && currentUser && currentUser.fcmToken !== fcmToken) {
      setDoc(doc(db, 'users', currentUser.id, 'private', 'secrets'), { fcmToken }, { merge: true });
      setCurrentUser(prev => prev ? { ...prev, fcmToken } : null);
    }
  }, [fcmToken, currentUser]);

  // Update lastSeen presence heartbeat for the active user.
  // The dependency is on currentUser.id only — we don't want to restart
  // the interval (and briefly flicker offline) every time a secondary
  // field like fcmToken or name is updated on the currentUser object.
  useEffect(() => {
    if (!currentUser) return;
    const userId = currentUser.id;

    const updatePresence = async (isOnline: boolean) => {
      try {
        const userDocRef = doc(db, 'users', userId);
        // On offline, set lastSeen to epoch 0 to immediately mark as offline
        const lastSeenVal = isOnline ? serverTimestamp() : new Date(0);
        await setDoc(userDocRef, { lastSeen: lastSeenVal }, { merge: true });
      } catch (err) {
        console.error('Failed to update presence status:', err);
      }
    };

    let isAppActive = true;

    window.onAppResume = () => {
      isAppActive = true;
      updatePresence(true);
    };

    window.onAppPause = () => {
      isAppActive = false;
      if (!activeCallRef.current) {
        updatePresence(false);
      }
    };

    window.onAppStop = () => {
      isAppActive = false;
      if (!activeCallRef.current) {
        updatePresence(false);
      }
    };

    // Mark online immediately on mount/auth
    updatePresence(true);

    // Send heartbeat every 60 seconds if page is visible
    const interval = setInterval(() => {
      if (isAppActive && document.visibilityState === 'visible') {
        updatePresence(true);
      }
    }, 60000);

    // Mark online when returning to app
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && isAppActive) {
        updatePresence(true);
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    // Try to mark offline on page unload
    const handleUnload = () => {
      updatePresence(false);
    };
    window.addEventListener('beforeunload', handleUnload);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('beforeunload', handleUnload);
      window.onAppResume = undefined;
      window.onAppPause = undefined;
      window.onAppStop = undefined;
      updatePresence(false);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.id]); // Only restart when the signed-in user changes, not on field updates

  // Listen for all users (only when authenticated)
  useEffect(() => {
    if (authState !== 'authenticated') return;
    const unsubscribe = onSnapshot(collection(db, 'users'), (snapshot) => {
      const usersData: User[] = [];
      snapshot.forEach((userDoc) => {
        usersData.push({ id: userDoc.id, ...userDoc.data() } as User);
      });
      setUsers(usersData);
    });
    return () => unsubscribe();
  }, [authState]);

  // Listen for incoming calls.
  // Depends on currentUser?.id only so that FCM token / name updates
  // don't tear down and recreate the subscription (which could briefly
  // create two concurrent listeners and deliver a duplicate call event).
  useEffect(() => {
    if (!currentUser) return;
    const userId = currentUser.id;

    const q = query(collection(db, 'calls'), where('calleeId', '==', userId));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
          const callData = change.doc.data();
          const callerId = callData.callerId;

          // Filter stale calls — ignore documents older than 120 seconds if timestamp exists.
          // If the timestamp doesn't exist yet (e.g. pending server sync), we assume it is
          // a new call and do not filter it out.
          const createdAt = callData.createdAt?.toDate?.();
          if (createdAt && Date.now() - createdAt.getTime() > 120000) return;

          if (callerId) {
            const callId = change.doc.id;
            handleIncomingCall(callerId, callId);
          }
        }
      });
    });
    return () => unsubscribe();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.id]); // Only re-subscribe when the user identity changes

  const handleRegister = async (name: string) => {
    const firebaseUser = auth.currentUser;
    if (!firebaseUser) return;

    const user: User = { id: firebaseUser.uid, name, lastSeen: serverTimestamp() };
    // Do NOT write fcmToken to public user document
    try {
      await setDoc(doc(db, 'users', firebaseUser.uid), user);
      if (fcmToken) {
        await setDoc(doc(db, 'users', firebaseUser.uid, 'private', 'secrets'), { fcmToken }, { merge: true });
        user.fcmToken = fcmToken;
      }
      setCurrentUser(user);
    } catch (e) {
      console.error('Error registering user:', e);
    }
  };

  const handleChangeName = async (newName: string) => {
    if (!currentUser) return;
    try {
      await setDoc(doc(db, 'users', currentUser.id), { name: newName }, { merge: true });
      setCurrentUser(prev => prev ? { ...prev, name: newName } : null);
    } catch (e) {
      console.error('Error updating name:', e);
    }
  };

  const handleInitiateCall = useCallback((remoteUserId: string) => {
    if (!currentUser) return;
    const callId = `${currentUser.id}_${remoteUserId}_${crypto.randomUUID()}`;
    setActiveCall({ remoteUserId, incoming: false, callId });
  }, [currentUser]);

  const handleEndCall = useCallback(() => {
    setActiveCall(null);
  }, []);

  // Determine if the app is currently loading (auth initialization, profile fetching, or version check)
  const isAppLoading = authState === 'loading' || profileLoading || versionState === 'checking';

  // If app is blocked due to version incompatibility, show the blocker screen
  if (versionState === 'blocked') {
    return (
      <div className="app-container">
        <div className="content" style={{ justifyContent: 'center', alignItems: 'center' }}>
          <div className="registration-container" style={{ textAlign: 'center' }}>
            <h2 style={{ color: 'var(--wa-red)', fontSize: '32px', margin: 0 }}>Update Required</h2>
            <p style={{ color: 'var(--wa-text-light)', fontSize: '20px', maxWidth: '480px', margin: '0 auto', marginTop: '16px' }}>
              Your application version is no longer supported. Please update to the latest version to continue.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Loading state while Firebase Auth initializes, profile is loading, or version is checking
  if (isAppLoading) {
    return (
      <div className="app-container">
        <div className="content" style={{ justifyContent: 'center', alignItems: 'center' }}>
          <p style={{ color: 'var(--wa-text-light)', fontSize: '20px' }}>Loading...</p>
        </div>
      </div>
    );
  }

  // Not authenticated — show PIN screen
  if (authState === 'unauthenticated') {
    return <PinScreen />;
  }

  // Error loading profile — show Error screen with Retry option
  if (profileError) {
    return (
      <div className="app-container">
        <div className="content">
          <div className="registration-container" style={{ textAlign: 'center' }}>
            <h2 style={{ color: 'var(--wa-red)', fontSize: '32px', margin: 0 }}>Error Loading Profile</h2>
            <p style={{ color: 'var(--wa-text-light)', fontSize: '20px', maxWidth: '480px', margin: '0 auto', marginTop: '16px' }}>
              {profileError}
            </p>
            <button
              className="btn"
              style={{ marginTop: '24px' }}
              onClick={() => {
                const firebaseUser = auth.currentUser;
                if (firebaseUser) {
                  loadUserProfile(firebaseUser.uid);
                }
              }}
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Authenticated but no profile — show Registration
  if (!currentUser) {
    return <Registration onRegister={handleRegister} />;
  }

  // Authenticated with profile — show Contacts or Call
  return (
    <div className="app-container">
      {activeCall ? (
        <CallScreen
          currentUser={currentUser}
          remoteUserId={activeCall.remoteUserId}
          isIncoming={activeCall.incoming}
          callId={activeCall.callId}
          onEndCall={handleEndCall}
          autoAnswer={activeCall.autoAnswer}
          preFetchedIceServers={preFetchedIceServers}
        />
      ) : (
        <ContactList
          currentUser={currentUser}
          users={users.filter(u => u.id !== currentUser.id)}
          onCallUser={handleInitiateCall}
          onChangeName={handleChangeName}
        />
      )}
    </div>
  );
}

export default App;
