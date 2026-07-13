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
                Log.d("TVVC", "FCM received INCOMING_CALL action. Showing notification.")
                showIncomingCallNotification(this, callId, callerId, callerName)
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

    companion object {
        fun showIncomingCallNotification(context: Context, callId: String, callerId: String?, callerName: String) {
            val channelId = "incoming_calls"
            val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val name = "Incoming Calls"
                val descriptionText = "Notifications for incoming calls"
                val importance = NotificationManager.IMPORTANCE_HIGH
                val channel = NotificationChannel(channelId, name, importance).apply {
                    description = descriptionText
                    enableLights(true)
                    enableVibration(true)
                    lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                }
                notificationManager.createNotificationChannel(channel)
            }

            val fullScreenIntent = Intent(context, MainActivity::class.java).apply {
                setAction("INCOMING_CALL")
                putExtra("callId", callId)
                putExtra("callerId", callerId)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            }

            val flags = if (Build.VERSION.SDK_INT >= 23) {
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            } else {
                PendingIntent.FLAG_UPDATE_CURRENT
            }

            val fullScreenPendingIntent = PendingIntent.getActivity(
                context,
                0,
                fullScreenIntent,
                flags
            )

            val answerIntent = Intent(context, MainActivity::class.java).apply {
                action = "ANSWER_CALL"
                putExtra("callId", callId)
                putExtra("callerId", callerId)
                putExtra("callerName", callerName)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            }
            val answerPendingIntent = PendingIntent.getActivity(
                context,
                1,
                answerIntent,
                flags
            )

            val declineIntent = Intent(context, CallActionReceiver::class.java).apply {
                action = "DECLINE_CALL"
                putExtra("callId", callId)
            }
            val declinePendingIntent = PendingIntent.getBroadcast(
                context,
                2,
                declineIntent,
                flags
            )

            val notificationBuilder = NotificationCompat.Builder(context, channelId)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("Incoming Call")
                .setContentText("Call from $callerName")
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setContentIntent(fullScreenPendingIntent)
                .setAutoCancel(true)
                .setOngoing(true)
                .addAction(R.mipmap.ic_launcher, "Answer", answerPendingIntent)
                .addAction(R.mipmap.ic_launcher, "Decline", declinePendingIntent)

            if (Build.VERSION.SDK_INT >= 34) {
                if (notificationManager.canUseFullScreenIntent()) {
                    notificationBuilder.setFullScreenIntent(fullScreenPendingIntent, true)
                }
            } else {
                notificationBuilder.setFullScreenIntent(fullScreenPendingIntent, true)
            }

            notificationManager.notify(101, notificationBuilder.build())
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
