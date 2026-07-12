import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";

const app = admin.initializeApp();
const db = getFirestore(app, "default");

// -------------------------------------------------------------
// Interfaces & Types
// -------------------------------------------------------------
interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

interface AdminConfig {
  pin?: string | number;
  meteredApiKey?: string;
  meteredAppName?: string;
  turnUsername?: string;
  turnCredential?: string;
}

interface VerifyPinRequest {
  pin?: string;
  deviceId?: string;
}

interface VerifyPinResponse {
  token: string;
}

interface GetTurnCredentialsResponse {
  iceServers: IceServer[];
}

interface CallDocument {
  callerId?: string;
  calleeId?: string;
}

interface UserDocument {
  fcmToken?: string;
}

interface PinAttempt {
  count: number;
  windowStart: number;
  expireAt?: Date;
}

interface CachedTurn {
  iceServers: IceServer[];
  expiresAt: number;
}

// Global Memory Cache for TURN credentials (persists in instances across calls)
let turnCache: CachedTurn | null = null;
const CACHE_DURATION_MS = 60 * 60 * 1000; // 1 hour

/**
 * Triggered when a new call document is created in Firestore.
 */
export const onCallCreated = onDocumentCreated({
  document: "calls/{callId}",
  database: "default"
}, async (event) => {
  const snapshot = event.data;
  if (!snapshot) return;
  const data = snapshot.data() as CallDocument | undefined;
  if (!data) return;

  const callId = event.params.callId;
  const callerId = data.callerId;
  const calleeId = data.calleeId;

  if (!callerId || !calleeId) {
    console.log(`Missing callerId or calleeId in document ${callId}`);
    return;
  }

  console.log(`New call initiated from ${callerId} to ${calleeId}`);

  // Fetch caller's display name
  let callerName = "Unknown Caller";
  try {
    const callerDoc = await db.collection("users").doc(callerId).get();
    if (callerDoc.exists) {
      const callerData = callerDoc.data();
      if (callerData && callerData.name) {
        callerName = callerData.name;
      }
    }
  } catch (error) {
    console.error("Error fetching caller profile:", error);
  }

  const userDoc = await db.collection("users").doc(calleeId).get();
  if (!userDoc.exists) {
    console.log(`User ${calleeId} not found`);
    return;
  }

  const userData = userDoc.data() as UserDocument | undefined;
  const fcmToken = userData?.fcmToken;

  if (!fcmToken) {
    console.log(`User ${calleeId} has no fcmToken registered.`);
    return;
  }

  console.log(`Sending wake-up push notification to ${fcmToken}`);

  const message = {
    token: fcmToken,
    data: {
      action: "INCOMING_CALL",
      callId: callId,
      callerId: callerId,
      callerName: callerName,
    },
    android: {
      priority: "high" as const,
    },
  };

  try {
    await admin.messaging().send(message);
    console.log("Successfully sent message");
  } catch (error) {
    console.error("Error sending message:", error);
  }
});

/**
 * Callable function: verifies a 6-digit family PIN.
 */
export const verifyPin = onCall<VerifyPinRequest, Promise<VerifyPinResponse>>(async (request) => {
  const { pin, deviceId } = request.data;

  if (!pin || typeof pin !== "string") {
    throw new HttpsError("invalid-argument", "PIN is required.");
  }
  if (!deviceId || typeof deviceId !== "string") {
    throw new HttpsError("invalid-argument", "Device ID is required.");
  }

  // Trusted client IP address from Google Frontend (GFE)
  const ip = request.rawRequest?.ip || "unknown_ip";

  // Sanitize IP address for use in Firestore document ID
  const safeIp = ip.replace(/[^a-zA-Z0-9.-]/g, "_");
  
  // 2-segment path fix
  const attemptRef = db.doc(`pinAttempts/${safeIp}`);
  const attemptDoc = await attemptRef.get();
  const now = Date.now();
  const WINDOW_MS = 60 * 60 * 1000; // 1 hour
  const MAX_ATTEMPTS = 10;

  if (attemptDoc.exists) {
    const data = attemptDoc.data() as PinAttempt | undefined;
    const count = data?.count ?? 0;
    const windowStart = data?.windowStart ?? 0;

    if (now - windowStart < WINDOW_MS && count >= MAX_ATTEMPTS) {
      console.warn(`Rate limit exceeded for IP ${safeIp}`);
      throw new HttpsError("resource-exhausted", "Too many failed attempts. Please try again later.");
    }
  }

  // Read the stored PIN from the admin config document
  const configDoc = await db.doc("admin/config").get();
  if (!configDoc.exists) {
    console.error("Admin config document not found. Create /admin/config with a 'pin' field.");
    throw new HttpsError("internal", "Server configuration error.");
  }

  const config = configDoc.data() as AdminConfig | undefined;
  const storedPin = config?.pin;

  if (!storedPin) {
    console.error("PIN not configured in /admin/config document.");
    throw new HttpsError("internal", "Server configuration error.");
  }

  if (pin !== String(storedPin)) {
    // Increment the failure counter transactionally with expireAt timestamp
    await db.runTransaction(async (transaction) => {
      const freshDoc = await transaction.get(attemptRef);
      const freshNow = Date.now();
      const existingData = freshDoc.exists ? (freshDoc.data() as PinAttempt) : null;
      const isNewWindow = !existingData || freshNow - existingData.windowStart >= WINDOW_MS;

      const windowStart = isNewWindow ? freshNow : existingData.windowStart;
      const count = isNewWindow ? 1 : existingData.count + 1;
      const expireAt = new Date(windowStart + WINDOW_MS);

      transaction.set(attemptRef, {
        count,
        windowStart,
        expireAt,
      });
    });
    throw new HttpsError("permission-denied", "Invalid PIN.");
  }

  // On success, clear the rate-limit counter
  if (attemptDoc.exists) {
    await attemptRef.delete();
  }

  // Create a custom auth token using the deviceId as the UID
  try {
    const token = await admin.auth().createCustomToken(deviceId);
    return { token };
  } catch (error) {
    console.error("Error creating custom token:", error);
    throw new HttpsError("internal", "Failed to create authentication token.");
  }
});

/**
 * Callable function: returns TURN server credentials for WebRTC.
 */
export const getTurnCredentials = onCall<unknown, Promise<GetTurnCredentialsResponse>>(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }

  const now = Date.now();
  if (turnCache && now < turnCache.expiresAt) {
    console.log("Returning cached TURN credentials (cache hit)");
    return { iceServers: turnCache.iceServers };
  }

  console.log("TURN credentials cache miss, fetching configuration...");
  const configDoc = await db.doc("admin/config").get();
  const config = configDoc.data() as AdminConfig | undefined;

  const meteredApiKey = config?.meteredApiKey;
  const meteredAppName = config?.meteredAppName || "tvvc";
  const turnUsername = config?.turnUsername;
  const turnCredential = config?.turnCredential;

  // Default to STUN-only configuration
  let iceServers: IceServer[] = [
    {
      urls: ["stun:stun.relay.metered.ca:80"],
    },
  ];

  let fetchedServers: IceServer[] | null = null;

  // Try dynamic API fetch first if apiKey is provided
  if (meteredApiKey) {
    try {
      const response = await fetch(`https://${meteredAppName}.metered.live/api/v1/turn/credentials?apiKey=${meteredApiKey}`);
      if (response.ok) {
        const data = await response.json();
        if (Array.isArray(data)) {
          console.log("Successfully fetched dynamic TURN credentials from metered.ca");
          fetchedServers = data as IceServer[];
        }
      } else {
        console.warn(`Metered.ca API returned status: ${response.status}`);
      }
    } catch (error) {
      console.error("Error fetching TURN credentials from metered.ca API:", error);
    }
  }

  if (fetchedServers) {
    turnCache = {
      iceServers: fetchedServers,
      expiresAt: now + CACHE_DURATION_MS,
    };
    return { iceServers: fetchedServers };
  }

  // Fallback to static credentials if API fetch failed or was not configured
  if (turnUsername && turnCredential) {
    console.log("Using fallback static TURN credentials");
    iceServers.push({
      urls: [
        "turn:global.relay.metered.ca:80",
        "turn:global.relay.metered.ca:443",
        "turns:global.relay.metered.ca:443?transport=tcp",
      ],
      username: turnUsername,
      credential: turnCredential,
    });
  } else {
    console.log("No TURN credentials configured, falling back to STUN-only");
  }

  // Cache static fallback configuration as well
  turnCache = {
    iceServers,
    expiresAt: now + CACHE_DURATION_MS,
  };

  return { iceServers };
});
