package com.sandesh247.tvvc

import android.content.Intent
import android.util.Log
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class MyFirebaseMessagingService : FirebaseMessagingService() {

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        super.onMessageReceived(remoteMessage)
        Log.d("TVVC", "From: ${remoteMessage.from}")

        // Check if message contains a data payload.
        if (remoteMessage.data.isNotEmpty()) {
            Log.d("TVVC", "Message data payload: ${remoteMessage.data}")

            // A call is coming in! Launch the app so it wakes up and shows the incoming call.
            // Screen wake is handled by the Activity's manifest attributes
            // (turnScreenOn + showWhenLocked), so no WakeLock is needed here.
            launchApp()
        }
    }

    /**
     * Called when the FCM registration token is refreshed (e.g. on token rotation or
     * app reinstall). We must write the new token to Firestore so the Cloud Function
     * can still deliver push-to-wake notifications.
     */
    override fun onNewToken(token: String) {
        Log.d("TVVC", "Refreshed FCM token: $token")

        val uid = FirebaseAuth.getInstance().currentUser?.uid
        if (uid == null) {
            Log.w("TVVC", "Token refreshed but no authenticated user — token will be synced on next login.")
            return
        }

        FirebaseFirestore.getInstance()
            .collection("users")
            .document(uid)
            .update("fcmToken", token)
            .addOnSuccessListener { Log.d("TVVC", "FCM token updated in Firestore.") }
            .addOnFailureListener { e -> Log.e("TVVC", "Failed to update FCM token in Firestore.", e) }
    }

    private fun launchApp() {
        val intent = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        startActivity(intent)
    }
}
