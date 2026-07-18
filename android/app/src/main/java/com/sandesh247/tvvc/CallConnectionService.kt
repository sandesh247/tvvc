package com.sandesh247.tvvc

import android.telecom.Connection
import android.telecom.ConnectionRequest
import android.telecom.ConnectionService
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.util.Log

/**
 * Android Telecom ConnectionService for self-managed VoIP calls.
 *
 * The system binds to this service when TelecomManager.addNewIncomingCall() is called.
 * It creates CallConnection instances that represent individual calls within the
 * Telecom framework, enabling:
 *   - Process kept alive by the system during ringing (no foreground service needed)
 *   - Proper audio routing (Bluetooth, car UI, etc.)
 *   - DND bypass for calls
 *   - Lock screen / full-screen call display
 *
 * Requires API 26+ (Android 8.0) with CAPABILITY_SELF_MANAGED.
 */
class CallConnectionService : ConnectionService() {

    companion object {
        private const val TAG = "TVVC"
    }

    /**
     * Called by the system when a new incoming call is reported via
     * TelecomManager.addNewIncomingCall(). Creates and returns a CallConnection
     * in the RINGING state.
     */
    override fun onCreateIncomingConnection(
        connectionManagerPhoneAccount: PhoneAccountHandle?,
        request: ConnectionRequest?
    ): Connection {
        Log.d(TAG, "CallConnectionService: onCreateIncomingConnection")

        val extras = request?.extras ?: android.os.Bundle()
        val callId = extras.getString("callId") ?: ""
        val callerId = extras.getString("callerId")
        val callerName = extras.getString("callerName") ?: "Unknown Caller"

        Log.d(TAG, "CallConnectionService: Creating connection for call=$callId, caller=$callerName")

        val connection = CallConnection(applicationContext, callId, callerId, callerName)

        // Set the address for display purposes
        if (request?.address != null) {
            connection.setAddress(request.address, TelecomManager.PRESENTATION_ALLOWED)
        }

        // Set the connection to ringing state — this triggers onShowIncomingCallUi()
        connection.setRinging()

        return connection
    }

    /**
     * Called when the system cannot create an incoming connection (e.g., too many active calls).
     * Falls back to showing a standard notification.
     */
    override fun onCreateIncomingConnectionFailed(
        connectionManagerPhoneAccount: PhoneAccountHandle?,
        request: ConnectionRequest?
    ) {
        Log.e(TAG, "CallConnectionService: onCreateIncomingConnectionFailed")

        val extras = request?.extras ?: android.os.Bundle()
        val callId = extras.getString("callId") ?: ""
        val callerId = extras.getString("callerId")
        val callerName = extras.getString("callerName") ?: "Unknown Caller"

        // Fall back to direct notification
        MyFirebaseMessagingService.showFallbackCallNotification(
            applicationContext, callId, callerId, callerName
        )
    }
}
