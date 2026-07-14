package com.sandesh247.tvvc

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import com.google.firebase.FirebaseApp
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.ListenerRegistration

class CallNotificationService : Service() {

    private var callListener: ListenerRegistration? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == "CANCEL_CALL") {
            Log.d("TVVC", "CallNotificationService: Received CANCEL_CALL. Stopping service.")
            stopSelf()
            return START_NOT_STICKY
        }

        val callId = intent?.getStringExtra("callId")
        val callerId = intent?.getStringExtra("callerId")
        val callerName = intent?.getStringExtra("callerName") ?: "Unknown Caller"

        Log.d("TVVC", "CallNotificationService onStartCommand: callId=$callId, callerId=$callerId, callerName=$callerName")

        if (callId.isNullOrEmpty()) {
            stopSelf()
            return START_NOT_STICKY
        }

        // 1. Create Notification and start Foreground
        val channelId = "incoming_calls"
        val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

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

        val fullScreenIntent = Intent(this, MainActivity::class.java).apply {
            action = "INCOMING_CALL"
            putExtra("callId", callId)
            putExtra("callerId", callerId)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }

        val pendingIntentFlags = if (Build.VERSION.SDK_INT >= 23) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }

        val fullScreenPendingIntent = PendingIntent.getActivity(
            this,
            0,
            fullScreenIntent,
            pendingIntentFlags
        )

        val answerIntent = Intent(this, MainActivity::class.java).apply {
            action = "ANSWER_CALL"
            putExtra("callId", callId)
            putExtra("callerId", callerId)
            putExtra("callerName", callerName)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        val answerPendingIntent = PendingIntent.getActivity(
            this,
            1,
            answerIntent,
            pendingIntentFlags
        )

        val declineIntent = Intent(this, CallActionReceiver::class.java).apply {
            action = "DECLINE_CALL"
            putExtra("callId", callId)
        }
        val declinePendingIntent = PendingIntent.getBroadcast(
            this,
            2,
            declineIntent,
            pendingIntentFlags
        )

        val notificationBuilder = NotificationCompat.Builder(this, channelId)
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

        val notification = notificationBuilder.build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(101, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL)
        } else {
            startForeground(101, notification)
        }

        // 2. Listen to Firestore call document cancellation
        try {
            val app = FirebaseApp.getInstance()
            val db = FirebaseFirestore.getInstance(app, BuildConfig.FIRESTORE_DATABASE_ID)
            callListener = db.collection("calls").document(callId)
                .addSnapshotListener { snapshot, error ->
                    if (error != null) {
                        Log.e("TVVC", "Firestore listener error", error)
                        return@addSnapshotListener
                    }
                    if (snapshot != null && !snapshot.exists() && !snapshot.metadata.isFromCache) {
                        Log.d("TVVC", "Call document does not exist on the server. Stopping service.")
                        stopSelf()
                    }
                }
        } catch (e: Exception) {
            Log.e("TVVC", "Error starting Firestore listener", e)
        }

        return START_NOT_STICKY
    }

    override fun onDestroy() {
        Log.d("TVVC", "CallNotificationService onDestroy")
        try {
            callListener?.remove()
        } catch (e: Exception) {
            Log.e("TVVC", "Error removing Firestore listener", e)
        }
        try {
            val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            notificationManager.cancel(101)
        } catch (e: Exception) {
            Log.e("TVVC", "Error cancelling notification 101", e)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
        super.onDestroy()
    }
}
