import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";

const app = admin.initializeApp();

const db = getFirestore(app, "default");

/**
 * Triggered when a new call document is created in Firestore.
 * Sends a high-priority FCM data message to the callee's device
 * to wake it up and open the app.
 */
export const onCallCreated = onDocumentCreated({
  document: "calls/{callId}",
  database: "default"
}, async (event) => {
  const snapshot = event.data;
  if (!snapshot) return;
  const data = snapshot.data();
  if (!data) return;

  const callId = event.params.callId;
  const callerId = data.callerId;
  const calleeId = data.calleeId;

  if (!callerId || !calleeId) {
    console.log(`Missing callerId or calleeId in document ${callId}`);
    return;
  }

  console.log(`New call initiated from ${callerId} to ${calleeId}`);

  // Fetch the recipient's user document to get their fcmToken
  const userDoc = await db.collection("users").doc(calleeId).get();
  if (!userDoc.exists) {
    console.log(`User ${calleeId} not found`);
    return;
  }

  const userData = userDoc.data();
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
 * On success, creates a Firebase Auth custom token for the given deviceId.
 *
 * The PIN is stored in Firestore at /admin/config (field: "pin").
 * This document is NOT readable by clients (security rules deny access).
 * Change the PIN anytime via the Firebase Console without redeploying.
 *
 * @param data.pin - The 6-digit PIN entered by the user
 * @param data.deviceId - A unique device identifier (used as Firebase Auth UID)
 * @returns { token: string } - A Firebase Auth custom token
 */
export const verifyPin = onCall(async (request) => {
  const { pin, deviceId } = request.data;

  if (!pin || typeof pin !== "string") {
    throw new HttpsError("invalid-argument", "PIN is required.");
  }
  if (!deviceId || typeof deviceId !== "string") {
    throw new HttpsError("invalid-argument", "Device ID is required.");
  }

  // Rate-limit by client IP address: max 10 failed attempts per IP per hour.
  // Extract client IP address from request headers or socket
  const rawRequest = request.rawRequest;
  let ip = "unknown_ip";
  const xForwardedFor = rawRequest?.headers['x-forwarded-for'];
  if (typeof xForwardedFor === 'string') {
    ip = xForwardedFor.split(',')[0].trim();
  } else if (rawRequest?.headers['x-appengine-user-ip']) {
    ip = String(rawRequest.headers['x-appengine-user-ip']);
  } else if (rawRequest?.socket?.remoteAddress) {
    ip = rawRequest.socket.remoteAddress;
  }

  // Sanitize IP address for use in Firestore document ID
  const safeIp = ip.replace(/[^a-zA-Z0-9.-]/g, "_");
  const attemptRef = db.doc(`admin/pinAttempts/${safeIp}`);
  const attemptDoc = await attemptRef.get();
  const now = Date.now();
  const WINDOW_MS = 60 * 60 * 1000; // 1 hour
  const MAX_ATTEMPTS = 10;

  if (attemptDoc.exists) {
    const { count = 0, windowStart = 0 } = attemptDoc.data() as { count: number; windowStart: number };
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

  const storedPin = configDoc.data()?.pin;

  if (!storedPin) {
    console.error("PIN not configured in /admin/config document.");
    throw new HttpsError("internal", "Server configuration error.");
  }

  if (pin !== String(storedPin)) {
    // Increment the failure counter transactionally to avoid race conditions
    await db.runTransaction(async (transaction) => {
      const freshDoc = await transaction.get(attemptRef);
      const freshNow = Date.now();
      const existingData = freshDoc.exists ? (freshDoc.data() as { count: number; windowStart: number }) : null;
      const isNewWindow = !existingData || freshNow - existingData.windowStart >= WINDOW_MS;

      transaction.set(attemptRef, {
        count: isNewWindow ? 1 : existingData.count + 1,
        windowStart: isNewWindow ? freshNow : existingData.windowStart,
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
 * Only accessible to authenticated users.
 *
 * TURN credentials are stored in Firestore at /admin/config
 * (fields: "turnUsername", "turnCredential").
 * Update them anytime via the Firebase Console.
 *
 * @returns { iceServers: RTCIceServer[] } - ICE server configuration
 */
export const getTurnCredentials = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }

  const configDoc = await db.doc("admin/config").get();
  const config = configDoc.data();

  const meteredApiKey = config?.meteredApiKey;
  const meteredAppName = config?.meteredAppName || "tvvc";
  const turnUsername = config?.turnUsername;
  const turnCredential = config?.turnCredential;

  // Try dynamic API fetch first if apiKey is provided
  if (meteredApiKey) {
    try {
      const response = await fetch(`https://${meteredAppName}.metered.live/api/v1/turn/credentials?apiKey=${meteredApiKey}`);
      if (response.ok) {
        const fetchedServers = await response.json();
        if (Array.isArray(fetchedServers)) {
          console.log("Successfully fetched dynamic TURN credentials from metered.ca");
          return { iceServers: fetchedServers };
        }
      } else {
        console.warn(`Metered.ca API returned status: ${response.status}`);
      }
    } catch (error) {
      console.error("Error fetching TURN credentials from metered.ca API:", error);
    }
  }

  // Fallback to static credentials if API fetch failed or was not configured
  const iceServers = [
    {
      urls: ["stun:stun.relay.metered.ca:80"],
    },
  ];

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
    } as any);
  } else {
    console.log("No TURN credentials configured, falling back to STUN-only");
  }

  return { iceServers };
});
