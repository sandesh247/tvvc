package com.sandesh247.tvvc

import android.content.Context
import android.content.Intent
import android.os.PowerManager
import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class MyFirebaseMessagingService : FirebaseMessagingService() {

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        super.onMessageReceived(remoteMessage)
        Log.d("TVVC", "From: ${remoteMessage.from}")

        // Check if message contains a data payload.
        if (remoteMessage.data.isNotEmpty()) {
            Log.d("TVVC", "Message data payload: ${remoteMessage.data}")
            
            // A call is coming in! Wake up the device and launch the app
            wakeUpScreenAndLaunchApp()
        }
    }

    override fun onNewToken(token: String) {
        Log.d("TVVC", "Refreshed token: $token")
        // We could send this token to the web app/Firestore so we can route calls to it
        // However, for our simple app, the web app could also just register its own FCM token,
        // or we use topic messaging (e.g. subscribe to a topic based on Display Name)
    }

    private fun wakeUpScreenAndLaunchApp() {
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        val wakeLock = powerManager.newWakeLock(
            PowerManager.FULL_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP or PowerManager.ON_AFTER_RELEASE,
            "TVVC::CallWakeLock"
        )

        // Acquire with timeout — auto-releases after 10 minutes
        wakeLock.acquire(10 * 60 * 1000L)

        // Launch MainActivity
        val intent = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        startActivity(intent)
        // Do NOT release here — let the timeout handle it so the screen stays on
    }
}
