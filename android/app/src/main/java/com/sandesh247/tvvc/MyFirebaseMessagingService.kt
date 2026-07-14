package com.sandesh247.tvvc

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import com.google.firebase.FirebaseApp
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
            val action = remoteMessage.data["action"]
            val callId = remoteMessage.data["callId"]
            val callerId = remoteMessage.data["callerId"]
            val callerName = remoteMessage.data["callerName"] ?: "Unknown Caller"

            if (action == "INCOMING_CALL" && !callId.isNullOrEmpty()) {
                Log.d("TVVC", "FCM received INCOMING_CALL action. Starting service.")
                val serviceIntent = Intent(this, CallNotificationService::class.java).apply {
                    putExtra("callId", callId)
                    putExtra("callerId", callerId)
                    putExtra("callerName", callerName)
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    startForegroundService(serviceIntent)
                } else {
                    startService(serviceIntent)
                }
            } else if (action == "CANCEL_CALL") {
                Log.d("TVVC", "FCM received CANCEL_CALL action. Stopping service and cancelling notification 101.")
                try {
                    val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                    notificationManager.cancel(101)
                } catch (e: Exception) {
                    Log.e("TVVC", "Failed to cancel notification 101 on CANCEL_CALL", e)
                }
                try {
                    val serviceIntent = Intent(this, CallNotificationService::class.java)
                    stopService(serviceIntent)
                } catch (e: Exception) {
                    Log.e("TVVC", "Failed to stop service on CANCEL_CALL", e)
                }
            } else {
                launchApp()
            }
        }
    }



    /**
     * Called when the FCM registration token is refreshed (e.g. on token rotation or
     * app reinstall). We must write the new token to Firestore so the Cloud Function
     * can still deliver push-to-wake notifications.
     */
    override fun onNewToken(token: String) {
        Log.d("TVVC", "Refreshed FCM token: $token")

        val sharedPref = getSharedPreferences("TVVC_PREFS", Context.MODE_PRIVATE)
        val uid = sharedPref.getString("auth_uid", null)

        if (uid.isNullOrEmpty()) {
            Log.w("TVVC", "Token refreshed but no cached auth_uid — token will be synced on next login.")
            return
        }

        val app = FirebaseApp.getInstance()
        FirebaseFirestore.getInstance(app, BuildConfig.FIRESTORE_DATABASE_ID)
            .collection("users")
            .document(uid)
            .collection("private")
            .document("secrets")
            .set(mapOf("fcmToken" to token), com.google.firebase.firestore.SetOptions.merge())
            .addOnSuccessListener { Log.d("TVVC", "FCM token updated in Firestore private secrets.") }
            .addOnFailureListener { e -> Log.e("TVVC", "Failed to update FCM token in Firestore private secrets.", e) }
    }

    private fun launchApp() {
        val intent = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        startActivity(intent)
    }
}
