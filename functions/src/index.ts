import { onDocumentCreated, onDocumentDeleted } from "firebase-functions/v2/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
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
  minClientVersion?: string;
}

interface GetMinClientVersionResponse {
  minClientVersion: string | null;
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
  configUpdateTime: number;
}

// Global Memory Cache for TURN credentials (persists in instances across calls)
let turnCache: CachedTurn | null = null;
let pendingPromise: Promise<GetTurnCredentialsResponse> | null = null;
const CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes cache window

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

  // Wrap profile/secrets fetching and FCM push notification dispatch in a try-catch block to handle errors robustly (F-21)
  try {
    let fcmToken: string | undefined;

    // Try retrieving FCM token from private secrets first
    try {
      const secretsDoc = await db.collection("users").doc(calleeId).collection("private").doc("secrets").get();
      if (secretsDoc.exists) {
        fcmToken = secretsDoc.data()?.fcmToken;
      }
    } catch (secretsError) {
      console.warn(`Error fetching secrets for user ${calleeId}:`, secretsError);
    }

    // Fallback to the user profile document if not found in secrets
    if (!fcmToken) {
      const userDoc = await db.collection("users").doc(calleeId).get();
      if (userDoc.exists) {
        const userData = userDoc.data() as UserDocument | undefined;
        fcmToken = userData?.fcmToken;
      } else {
        console.log(`User ${calleeId} profile not found`);
        return;
      }
    }

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
        ttl: 30000,
      },
    };

    try {
      await admin.messaging().send(message);
      console.log("Successfully sent FCM message");
    } catch (error: any) {
      console.error("Error sending message via FCM:", error);
      const errorCode = error?.code;
      const errorMessage = error?.message || "";
      const isStaleToken = errorCode === "messaging/invalid-registration-token" ||
        errorCode === "messaging/registration-token-not-registered" ||
        errorCode === "messaging/invalid-argument" ||
        errorMessage.includes("registration-token-not-registered");

      if (isStaleToken) {
        console.log(`Stale token detected for user ${calleeId}. Transactionally cleaning up.`);
        try {
          const userRef = db.collection("users").doc(calleeId);
          const secretsRef = userRef.collection("private").doc("secrets");
          await db.runTransaction(async (transaction) => {
            const userSnap = await transaction.get(userRef);
            const secretsSnap = await transaction.get(secretsRef);
            
            const updates: { [key: string]: any } = {};
            if (userSnap.exists && userSnap.data()?.fcmToken === fcmToken) {
              updates.fcmToken = admin.firestore.FieldValue.delete();
            }
            
            const secretsUpdates: { [key: string]: any } = {};
            if (secretsSnap.exists && secretsSnap.data()?.fcmToken === fcmToken) {
              secretsUpdates.fcmToken = admin.firestore.FieldValue.delete();
            }

            if (Object.keys(updates).length > 0) {
              transaction.update(userRef, updates);
            }
            if (Object.keys(secretsUpdates).length > 0) {
              transaction.update(secretsRef, secretsUpdates);
            }
          });
          console.log(`Successfully completed transactional stale token cleanup for user ${calleeId}`);
        } catch (txError) {
          console.error("Error running transactional token cleanup:", txError);
        }
      }
    }
  } catch (error) {
    console.error("Error fetching callee profile or dispatching FCM notification:", error);
  }
});

/**
 * Triggered when a call document is deleted in Firestore.
 */
export const onCallDeleted = onDocumentDeleted({
  document: "calls/{callId}",
  database: "default"
}, async (event) => {
  const snapshot = event.data;
  if (!snapshot) return;
  const data = snapshot.data() as CallDocument | undefined;
  if (!data) return;

  const callId = event.params.callId;
  const calleeId = data.calleeId;

  if (!calleeId) {
    console.log(`Missing calleeId in deleted document ${callId}`);
    return;
  }

  console.log(`Call ${callId} was deleted. Cancelling call for callee ${calleeId}`);

  try {
    let fcmToken: string | undefined;

    // Try retrieving FCM token from private secrets first
    try {
      const secretsDoc = await db.collection("users").doc(calleeId).collection("private").doc("secrets").get();
      if (secretsDoc.exists) {
        fcmToken = secretsDoc.data()?.fcmToken;
      }
    } catch (secretsError) {
      console.warn(`Error fetching secrets for user ${calleeId} during deletion:`, secretsError);
    }

    // Fallback to the user profile document if not found in secrets
    if (!fcmToken) {
      const userDoc = await db.collection("users").doc(calleeId).get();
      if (userDoc.exists) {
        const userData = userDoc.data() as UserDocument | undefined;
        fcmToken = userData?.fcmToken;
      } else {
        console.log(`User ${calleeId} profile not found during call deletion.`);
        return;
      }
    }

    if (!fcmToken) {
      console.log(`User ${calleeId} has no fcmToken registered during call deletion.`);
      return;
    }

    console.log(`Sending CANCEL_CALL FCM notification to ${fcmToken}`);

    const message = {
      token: fcmToken,
      data: {
        action: "CANCEL_CALL",
        callId: callId,
      },
      android: {
        priority: "high" as const,
        ttl: 30000,
      },
    };

    try {
      await admin.messaging().send(message);
      console.log("Successfully sent CANCEL_CALL FCM message");
    } catch (error: any) {
      console.error("Error sending CANCEL_CALL FCM notification:", error);
      const errorCode = error?.code;
      const errorMessage = error?.message || "";
      const isStaleToken = errorCode === "messaging/invalid-registration-token" ||
        errorCode === "messaging/registration-token-not-registered" ||
        errorCode === "messaging/invalid-argument" ||
        errorMessage.includes("registration-token-not-registered");

      if (isStaleToken) {
        console.log(`Stale token detected for user ${calleeId}. Transactionally cleaning up.`);
        try {
          const userRef = db.collection("users").doc(calleeId);
          const secretsRef = userRef.collection("private").doc("secrets");
          await db.runTransaction(async (transaction) => {
            const userSnap = await transaction.get(userRef);
            const secretsSnap = await transaction.get(secretsRef);
            
            const updates: { [key: string]: any } = {};
            if (userSnap.exists && userSnap.data()?.fcmToken === fcmToken) {
              updates.fcmToken = admin.firestore.FieldValue.delete();
            }
            
            const secretsUpdates: { [key: string]: any } = {};
            if (secretsSnap.exists && secretsSnap.data()?.fcmToken === fcmToken) {
              secretsUpdates.fcmToken = admin.firestore.FieldValue.delete();
            }

            if (Object.keys(updates).length > 0) {
              transaction.update(userRef, updates);
            }
            if (Object.keys(secretsUpdates).length > 0) {
              transaction.update(secretsRef, secretsUpdates);
            }
          });
          console.log(`Successfully completed transactional stale token cleanup for user ${calleeId}`);
        } catch (txError) {
          console.error("Error running transactional token cleanup:", txError);
        }
      }
    }
  } catch (error) {
    console.error("Error handling call deletion:", error);
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
  const configRef = db.doc("admin/config");
  const WINDOW_MS = 60 * 60 * 1000; // 1 hour
  const MAX_ATTEMPTS = 10;

  // Move rate limit counter checking, config validation, and increment/delete inside transaction to prevent TOCTOU vulnerability (F-02)
  const isPinValid = await db.runTransaction(async (transaction) => {
    const freshDoc = await transaction.get(attemptRef);
    const configDoc = await transaction.get(configRef);
    const freshNow = Date.now();

    // Check rate limit first
    if (freshDoc.exists) {
      const data = freshDoc.data() as PinAttempt | undefined;
      const count = data?.count ?? 0;
      const windowStart = data?.windowStart ?? 0;

      if (freshNow - windowStart < WINDOW_MS && count >= MAX_ATTEMPTS) {
        console.warn(`Rate limit exceeded for IP ${safeIp}`);
        throw new HttpsError("resource-exhausted", "Too many failed attempts. Please try again later.");
      }
    }

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

    if (pin === String(storedPin)) {
      // On success, clear the rate-limit counter inside the transaction
      if (freshDoc.exists) {
        transaction.delete(attemptRef);
      }
      return true;
    } else {
      // Increment the failure counter transactionally with expireAt timestamp
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
      return false;
    }
  });

  if (!isPinValid) {
    throw new HttpsError("permission-denied", "Invalid PIN.");
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
export const getTurnCredentials = onCall<unknown, Promise<GetTurnCredentialsResponse>>((request) => {
  if (!request.auth) {
    return Promise.reject(new HttpsError("unauthenticated", "Authentication required."));
  }

  // Coalesce concurrent requests by returning the same pending promise if fetch is active (F-20)
  if (pendingPromise) {
    console.log("Awaiting active TURN credentials promise (coalescing)");
    return pendingPromise;
  }

  pendingPromise = (async (): Promise<GetTurnCredentialsResponse> => {
    try {
      const now = Date.now();
      // Retrieve the admin config to check for changes (F-19)
      const configDoc = await db.doc("admin/config").get();
      const config = configDoc.data() as AdminConfig | undefined;
      const configUpdateTime = configDoc.updateTime?.toMillis() || 0;

      // Check if configuration has been updated. If so, invalidate cache.
      if (turnCache && turnCache.configUpdateTime !== configUpdateTime) {
        console.log("Admin config changed. Invalidating TURN cache.");
        turnCache = null;
      }

      // If cache is valid, return it.
      if (turnCache && now < turnCache.expiresAt) {
        console.log("Returning cached TURN credentials (cache hit)");
        return { iceServers: turnCache.iceServers };
      }

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
        iceServers = fetchedServers;
      } else if (turnUsername && turnCredential) {
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

      // Cache the fetched credentials along with the config update timestamp
      turnCache = {
        iceServers,
        expiresAt: Date.now() + CACHE_DURATION_MS,
        configUpdateTime,
      };

      return { iceServers };
    } catch (error) {
      console.error("Error retrieving configuration or fetching TURN credentials:", error);
      throw new HttpsError("internal", "Failed to retrieve TURN credentials.");
    } finally {
      // Clear the pending promise once resolve/reject completes
      pendingPromise = null;
    }
  })();

  return pendingPromise;
});

/**
 * Callable function: gets the minimum client version from admin/config.
 */
export const getMinClientVersion = onCall<unknown, Promise<GetMinClientVersionResponse>>(async (request) => {
  try {
    const configDoc = await db.doc("admin/config").get();
    if (!configDoc.exists) {
      return { minClientVersion: null };
    }
    const config = configDoc.data() as AdminConfig | undefined;
    return { minClientVersion: config?.minClientVersion ?? null };
  } catch (error) {
    console.error("Error retrieving minimum client version:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    throw new HttpsError("internal", `Failed to retrieve minimum client version: ${message}`);
  }
});

/**
 * Scheduled GC function: deletes call documents (and their subcollections) older than 10 minutes (F-10).
 * Runs every 5 minutes.
 */
export const callsGc = onSchedule({
  schedule: "every 5 minutes",
}, async (event) => {
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
  console.log(`Starting Calls GC. Deleting calls created before ${tenMinutesAgo.toISOString()}`);

  try {
    const snapshot = await db.collection("calls")
      .where("createdAt", "<", tenMinutesAgo)
      .get();

    if (snapshot.empty) {
      console.log("No stale calls found.");
      return;
    }

    console.log(`Found ${snapshot.size} stale calls to delete.`);

    // Use db.recursiveDelete to delete call document and its subcollections recursively
    for (const doc of snapshot.docs) {
      try {
        await db.recursiveDelete(doc.ref);
        console.log(`Recursively deleted call document ${doc.id}`);
      } catch (err) {
        console.error(`Failed to delete call document ${doc.id}:`, err);
      }
    }
  } catch (error) {
    console.error("Error running Calls GC:", error);
  }
});

/**
 * Scheduled GC function: deletes user profiles (and their subcollections) with lastSeen > 30 days (F-22).
 * Runs once every 24 hours.
 */
export const usersGc = onSchedule({
  schedule: "every 24 hours",
}, async (event) => {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  console.log(`Starting Users GC. Deleting users inactive since ${thirtyDaysAgo.toISOString()}`);

  try {
    const snapshot = await db.collection("users")
      .where("lastSeen", "<", thirtyDaysAgo)
      .get();

    if (snapshot.empty) {
      console.log("No inactive users found in Firestore.");
      return;
    }

    console.log(`Checking ${snapshot.size} potentially inactive users...`);

    for (const doc of snapshot.docs) {
      const uid = doc.id;
      let shouldDelete = false;

      try {
        // Fetch UserRecord from Firebase Auth to inspect actual last activity (lastSignInTime / creationTime).
        // This is necessary because presence tracking sets lastSeen to epoch 0 (1970-01-01) when a user goes offline,
        // which makes any offline user look inactive for > 30 days.
        const userRecord = await admin.auth().getUser(uid);
        const lastSignInTime = userRecord.metadata.lastSignInTime 
          ? new Date(userRecord.metadata.lastSignInTime) 
          : new Date(0);
        const creationTime = userRecord.metadata.creationTime 
          ? new Date(userRecord.metadata.creationTime) 
          : new Date(0);
        
        const lastActiveTime = Math.max(lastSignInTime.getTime(), creationTime.getTime());

        if (lastActiveTime < thirtyDaysAgo.getTime()) {
          console.log(`User ${uid} has been inactive on Auth since ${new Date(lastActiveTime).toISOString()}. Marking for deletion.`);
          shouldDelete = true;
        }
      } catch (err: any) {
        if (err.code === "auth/user-not-found") {
          console.log(`User ${uid} not found in Firebase Auth. Marking for deletion.`);
          shouldDelete = true;
        } else {
          console.error(`Error checking Auth status for user ${uid}:`, err);
        }
      }

      if (shouldDelete) {
        try {
          await db.recursiveDelete(doc.ref);
          console.log(`Recursively deleted user document and subcollections for ${uid}`);
        } catch (deleteErr) {
          console.error(`Failed to delete user document ${uid}:`, deleteErr);
        }
      }
    }
  } catch (error) {
    console.error("Error running Users GC:", error);
  }
});
