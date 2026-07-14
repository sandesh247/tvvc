package com.sandesh247.tvvc

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.google.firebase.FirebaseApp
import com.google.firebase.firestore.FirebaseFirestore

class CallActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action
        val callId = intent?.getStringExtra("callId")
        Log.d("TVVC", "CallActionReceiver received action: $action, callId: $callId")
        if (action == "DECLINE_CALL" && !callId.isNullOrEmpty()) {
            try {
                val serviceIntent = Intent(context, CallNotificationService::class.java)
                context.stopService(serviceIntent)
            } catch (e: Exception) {
                Log.e("TVVC", "Failed to stop CallNotificationService", e)
            }

            try {
                // Cancel notification 101
                val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                notificationManager.cancel(101)
            } catch (e: Exception) {
                Log.e("TVVC", "Failed to cancel notification 101", e)
            }

            try {
                // Delete the Firestore call document under collection "calls" with callId
                val app = FirebaseApp.getInstance()
                val db = FirebaseFirestore.getInstance(app, BuildConfig.FIRESTORE_DATABASE_ID)
                db.collection("calls").document(callId)
                    .delete()
                    .addOnSuccessListener {
                        Log.d("TVVC", "Firestore document for call $callId deleted successfully")
                    }
                    .addOnFailureListener { e ->
                        Log.e("TVVC", "Failed to delete Firestore document for call $callId", e)
                    }
            } catch (e: Exception) {
                Log.e("TVVC", "Error deleting Firestore document", e)
            }
        }
    }
}
