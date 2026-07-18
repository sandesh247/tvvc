package com.sandesh247.tvvc

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.telecom.Connection
import android.telecom.DisconnectCause
import android.telecom.TelecomManager
import android.util.Log
import com.google.firebase.FirebaseApp
import com.google.firebase.firestore.FirebaseFirestore

/**
 * Represents a single self-managed VoIP call within the Android Telecom framework.
 *
 * Each incoming call creates one CallConnection instance. The system keeps our process
 * alive as long as this Connection exists, eliminating the need for a foreground service
 * to anchor the process during ringing.
 *
 * Requires API 26+ (Android 8.0). Lower API levels fall back to the legacy notification path.
 */
class CallConnection(
    private val context: Context,
    private val callId: String,
    private val callerId: String?,
    private val callerName: String
) : Connection() {

    companion object {
        private const val TAG = "TVVC"

        /**
         * Static reference to the currently ringing or active connection.
         * This app only supports a single concurrent call, so a static reference is safe.
         */
        @Volatile
        var activeConnection: CallConnection? = null

        /**
         * Disconnects and destroys the active connection if it matches the given callId.
         * Called when the caller cancels the call (via CANCEL_CALL FCM).
         */
        fun cancelActiveConnection(callId: String?) {
            val conn = activeConnection ?: return
            if (callId == null || conn.callId == callId) {
                Log.d(TAG, "CallConnection: Cancelling active connection for call ${conn.callId}")
                conn.setDisconnected(DisconnectCause(DisconnectCause.CANCELED))
                conn.destroy()
                activeConnection = null

                // Also cancel the notification
                try {
                    val nm = conn.context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                    nm.cancel(101)
                } catch (e: Exception) {
                    Log.e(TAG, "Error cancelling notification on connection cancel", e)
                }
            }
        }
    }

    init {
        connectionProperties = PROPERTY_SELF_MANAGED
        setAudioModeIsVoip(true)

        // Set caller display name
        setCallerDisplayName(callerName, TelecomManager.PRESENTATION_ALLOWED)

        activeConnection = this
    }

    /**
     * Called by the system to tell us to show our incoming call UI.
     * For self-managed connections, WE are responsible for showing the call notification.
     */
    override fun onShowIncomingCallUi() {
        Log.d(TAG, "CallConnection: onShowIncomingCallUi for call $callId from $callerName")
        MyFirebaseMessagingService.showFallbackCallNotification(context, callId, callerId, callerName)
    }

    /**
     * Called when the user answers the call (e.g., from the notification's Answer button).
     */
    override fun onAnswer() {
        Log.d(TAG, "CallConnection: onAnswer for call $callId")
        setActive()

        // Cancel the ringing notification
        try {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.cancel(101)
        } catch (e: Exception) {
            Log.e(TAG, "Error cancelling notification on answer", e)
        }

        // Launch MainActivity to handle the WebRTC call
        val intent = Intent(context, MainActivity::class.java).apply {
            action = "ANSWER_CALL"
            putExtra("callId", callId)
            putExtra("callerId", callerId)
            putExtra("callerName", callerName)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        context.startActivity(intent)
    }

    /**
     * Called when the user rejects/declines the call.
     */
    override fun onReject() {
        Log.d(TAG, "CallConnection: onReject for call $callId")
        setDisconnected(DisconnectCause(DisconnectCause.REJECTED))
        destroy()
        activeConnection = null

        // Cancel the ringing notification
        try {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.cancel(101)
        } catch (e: Exception) {
            Log.e(TAG, "Error cancelling notification on reject", e)
        }

        // Delete the Firestore call document to notify the caller
        try {
            val app = FirebaseApp.getInstance()
            val db = FirebaseFirestore.getInstance(app, BuildConfig.FIRESTORE_DATABASE_ID)
            db.collection("calls").document(callId)
                .delete()
                .addOnSuccessListener { Log.d(TAG, "Call document $callId deleted on reject") }
                .addOnFailureListener { e -> Log.e(TAG, "Failed to delete call document on reject", e) }
        } catch (e: Exception) {
            Log.e(TAG, "Error deleting call document on reject", e)
        }
    }

    /**
     * Called when the call is disconnected (e.g., user hangs up during an active call).
     */
    override fun onDisconnect() {
        Log.d(TAG, "CallConnection: onDisconnect for call $callId")
        setDisconnected(DisconnectCause(DisconnectCause.LOCAL))
        destroy()
        activeConnection = null
    }
}
