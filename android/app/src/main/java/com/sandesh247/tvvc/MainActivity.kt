package com.sandesh247.tvvc

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.Build
import android.provider.Settings
import android.util.Log
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.FirebaseMessaging
import com.sandesh247.tvvc.BuildConfig

class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private var fcmToken: String? = null
    private var isPageLoaded = false
    private var isCallActive = false
    private var pendingCallAction: String? = null
    private var isAppReady = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Request permissions
        val permissionsToRequest = mutableListOf<String>()
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            permissionsToRequest.add(Manifest.permission.CAMERA)
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            permissionsToRequest.add(Manifest.permission.RECORD_AUDIO)
        }
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                permissionsToRequest.add(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
        if (permissionsToRequest.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, permissionsToRequest.toTypedArray(), 1)
        }

        // Request USE_FULL_SCREEN_INTENT permission on Android 14+ if not already granted
        if (Build.VERSION.SDK_INT >= 34) {
            val notificationManager = getSystemService(android.content.Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
            if (!notificationManager.canUseFullScreenIntent()) {
                try {
                    val intent = Intent(android.provider.Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT).apply {
                        data = android.net.Uri.fromParts("package", packageName, null)
                    }
                    startActivity(intent)
                } catch (e: Exception) {
                    Log.e("TVVC", "Failed to launch full screen intent settings screen", e)
                }
            }
        }

        webView = WebView(this)
        webView.fitsSystemWindows = true
        setContentView(webView)

        webView.isFocusable = true
        webView.post {
            webView.requestFocus()
        }

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            useWideViewPort = false
            loadWithOverviewMode = false
            mediaPlaybackRequiresUserGesture = false
        }

        // Register the JS bridge
        webView.addJavascriptInterface(AndroidBridge(this), "AndroidBridge")

        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                isPageLoaded = true
                injectTokenIfAvailable()
                view?.post {
                    view.requestFocus()
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                Log.d("TVVC", "Permission request: ${request.resources.joinToString()}")
                runOnUiThread {
                    request.grant(request.resources)
                }
            }
        }

        // Load the initial URL using handleIntent
        handleIntent(intent)

        // Retrieve FCM Token and pass to WebView
        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
            if (!task.isSuccessful) {
                Log.w("TVVC", "Fetching FCM registration token failed", task.exception)
                return@addOnCompleteListener
            }

            val token = task.result
            Log.d("TVVC", "FCM Token: $token")
            this.fcmToken = token

            // Push token immediately if page is already loaded and hook is active
            injectTokenIfAvailable()
        }
    }

    override fun onResume() {
        super.onResume()
        if (::webView.isInitialized) {
            webView.evaluateJavascript("if (window.onAppResume) { window.onAppResume(); }", null)
        }
    }

    override fun onPause() {
        super.onPause()
        if (::webView.isInitialized) {
            webView.evaluateJavascript("if (window.onAppPause) { window.onAppPause(); }", null)
        }
    }

    override fun onStop() {
        super.onStop()
        if (::webView.isInitialized) {
            webView.evaluateJavascript("if (window.onAppStop) { window.onAppStop(); }", null)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        if (intent == null) {
            if (!isPageLoaded) {
                webView.loadUrl(BuildConfig.WEB_APP_URL)
            }
            return
        }

        val action = intent.action
        val callId = intent.getStringExtra("callId")
        val callerId = intent.getStringExtra("callerId")

        Log.d("TVVC", "handleIntent: action=$action, callId=$callId, callerId=$callerId")

        if (action == "CANCEL_CALL") {
            Log.d("TVVC", "Received CANCEL_CALL action. Notifying web app.")
            runOnUiThread {
                webView.evaluateJavascript("if (window.onCallCancelledBySystem) { window.onCallCancelledBySystem(); }", null)
            }
            return
        }

        if (action == "ANSWER_CALL" && !callId.isNullOrEmpty()) {
            try {
                val notificationManager = getSystemService(android.content.Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
                notificationManager.cancel(101)
            } catch (e: Exception) {
                Log.e("TVVC", "Failed to cancel notification 101", e)
            }

            val serviceIntent = Intent(this, CallNotificationService::class.java)
            try {
                stopService(serviceIntent)
            } catch (e: Exception) {
                Log.e("TVVC", "Failed to stop CallNotificationService", e)
            }

            if (!isAppReady) {
                pendingCallAction = "window.handleIncomingCallIntent('$callId', '${callerId ?: ""}', true)"
                if (!isPageLoaded) {
                    webView.loadUrl(BuildConfig.WEB_APP_URL)
                }
            } else {
                Log.d("TVVC", "App ready, evaluating handleIncomingCallIntent via JS with autoAnswer=true.")
                runOnUiThread {
                    webView.evaluateJavascript("window.handleIncomingCallIntent('$callId', '${callerId ?: ""}', true);", null)
                }
            }
            return
        }

        if (action == "INCOMING_CALL" && !callId.isNullOrEmpty()) {
            if (!isAppReady) {
                pendingCallAction = "window.handleIncomingCallIntent('$callId', '${callerId ?: ""}', false)"
                if (!isPageLoaded) {
                    webView.loadUrl(BuildConfig.WEB_APP_URL)
                }
            } else {
                Log.d("TVVC", "App ready, evaluating handleIncomingCallIntent via JS with autoAnswer=false.")
                runOnUiThread {
                    webView.evaluateJavascript("window.handleIncomingCallIntent('$callId', '${callerId ?: ""}', false);", null)
                }
            }
        } else {
            if (!isPageLoaded) {
                Log.d("TVVC", "Loading default URL: ${BuildConfig.WEB_APP_URL}")
                webView.loadUrl(BuildConfig.WEB_APP_URL)
            } else {
                Log.d("TVVC", "Page already loaded, ignoring default launcher intent.")
            }
        }
    }

    private fun injectTokenIfAvailable() {
        val token = fcmToken ?: return
        if (isPageLoaded) {
            val js = """
                if (window.handleFcmToken) {
                    window.handleFcmToken('$token');
                }
            """.trimIndent()
            webView.evaluateJavascript(js, null)
        }
    }

    private fun triggerPendingCallAction() {
        pendingCallAction?.let { js ->
            Log.d("TVVC", "Evaluating pending call action: $js")
            webView.evaluateJavascript("if (window.handleIncomingCallIntent) { $js; }", null)
            pendingCallAction = null
        }
    }

    class AndroidBridge(activity: MainActivity) {
        private val activityRef = java.lang.ref.WeakReference(activity)

        @android.webkit.JavascriptInterface
        fun syncUid(uid: String?) {
            val activity = activityRef.get() ?: return
            val sharedPref = activity.getSharedPreferences("TVVC_PREFS", android.content.Context.MODE_PRIVATE)
            if (!uid.isNullOrEmpty()) {
                sharedPref.edit().putString("auth_uid", uid).apply()
                Log.d("TVVC", "syncUid: saved auth_uid = $uid")
            } else {
                sharedPref.edit().remove("auth_uid").apply()
                Log.d("TVVC", "syncUid: removed auth_uid")
            }
            activity.runOnUiThread {
                activity.injectTokenIfAvailable()
            }
        }

        @android.webkit.JavascriptInterface
        fun getFcmToken(): String? {
            val activity = activityRef.get() ?: return null
            return activity.fcmToken
        }

        @android.webkit.JavascriptInterface
        fun onAppReady() {
            val activity = activityRef.get() ?: return
            Log.d("TVVC", "onAppReady called from JS Bridge")
            activity.runOnUiThread {
                activity.isAppReady = true
                activity.triggerPendingCallAction()
            }
        }

        @android.webkit.JavascriptInterface
        fun onIncomingCallReceived(callId: String, callerId: String, callerName: String) {
            val activity = activityRef.get() ?: return
            Log.d("TVVC", "onIncomingCallReceived via JS Bridge: callId=$callId, callerId=$callerId, callerName=$callerName")
            
            val serviceIntent = Intent(activity, CallNotificationService::class.java).apply {
                putExtra("callId", callId)
                putExtra("callerId", callerId)
                putExtra("callerName", callerName)
            }
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    activity.startForegroundService(serviceIntent)
                } else {
                    activity.startService(serviceIntent)
                }
            } catch (e: Exception) {
                Log.e("TVVC", "Failed to start foreground service from JS Bridge", e)
            }

            // Attempt to bring app to foreground
            activity.runOnUiThread {
                val act = activityRef.get() ?: return@runOnUiThread
                try {
                    val activityIntent = Intent(act, MainActivity::class.java).apply {
                        action = "INCOMING_CALL"
                        putExtra("callId", callId)
                        putExtra("callerId", callerId)
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    }
                    act.startActivity(activityIntent)
                } catch (e: Exception) {
                    Log.e("TVVC", "Error trying to launch activity on call start", e)
                }
            }
        }

        @android.webkit.JavascriptInterface
        fun cancelIncomingCallNotification() {
            val activity = activityRef.get() ?: return
            Log.d("TVVC", "cancelIncomingCallNotification via JS Bridge")
            val intent = Intent(activity, CallNotificationService::class.java)
            activity.stopService(intent)
        }

        @android.webkit.JavascriptInterface
        fun setSpeakerphoneOn(on: Boolean) {
            val activity = activityRef.get() ?: return
            Log.d("TVVC", "setSpeakerphoneOn: $on")
            try {
                val audioManager = activity.getSystemService(android.content.Context.AUDIO_SERVICE) as android.media.AudioManager
                audioManager.isSpeakerphoneOn = on
            } catch (e: Exception) {
                Log.e("TVVC", "Error setting speakerphone state", e)
            }
        }

        @android.webkit.JavascriptInterface
        fun setCallActive(active: Boolean) {
            val activity = activityRef.get() ?: return
            activity.runOnUiThread {
                activity.isCallActive = active
            }
            try {
                val audioManager = activity.getSystemService(android.content.Context.AUDIO_SERVICE) as android.media.AudioManager
                audioManager.mode = if (active) android.media.AudioManager.MODE_IN_COMMUNICATION else android.media.AudioManager.MODE_NORMAL
            } catch (e: Exception) {
                Log.e("TVVC", "Error setting call active audio mode", e)
            }
        }

        @android.webkit.JavascriptInterface
        fun getDeviceId(): String {
            val activity = activityRef.get() ?: return java.util.UUID.randomUUID().toString()
            val sharedPref = activity.getSharedPreferences("TVVC_PREFS", android.content.Context.MODE_PRIVATE)
            
            // Check if there is already a device ID stored in SharedPreferences
            var deviceId = sharedPref.getString("device_id", null)
            if (!deviceId.isNullOrEmpty()) {
                Log.d("TVVC", "getDeviceId: returning cached device ID: $deviceId")
                return deviceId
            }
            
            // Try to get ANDROID_ID
            try {
                val androidId = android.provider.Settings.Secure.getString(
                    activity.contentResolver,
                    android.provider.Settings.Secure.ANDROID_ID
                )
                // Filter out null, empty, or generic emulator ID
                if (!androidId.isNullOrEmpty() && androidId != "9774d56d682e549c") {
                    deviceId = androidId
                    Log.d("TVVC", "getDeviceId: retrieved ANDROID_ID: $deviceId")
                }
            } catch (e: Exception) {
                Log.e("TVVC", "Error retrieving ANDROID_ID", e)
            }
            
            // Fallback to random UUID if ANDROID_ID was unavailable or invalid
            if (deviceId.isNullOrEmpty()) {
                deviceId = java.util.UUID.randomUUID().toString()
                Log.d("TVVC", "getDeviceId: fell back to random UUID: $deviceId")
            }
            
            // Persist the ID (whether it's ANDROID_ID or generated UUID)
            sharedPref.edit().putString("device_id", deviceId).apply()
            return deviceId
        }

        @android.webkit.JavascriptInterface
        fun getVersionName(): String {
            return BuildConfig.VERSION_NAME
        }

        @android.webkit.JavascriptInterface
        fun getVersionCode(): Int {
            return BuildConfig.VERSION_CODE
        }

        @android.webkit.JavascriptInterface
        fun requestIgnoreBatteryOptimizations() {
            val activity = activityRef.get() ?: return
            try {
                val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                    data = Uri.parse("package:${activity.packageName}")
                }
                activity.startActivity(intent)
            } catch (e: Exception) {
                Log.e("TVVC", "Error launching ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS", e)
            }
        }

        @android.webkit.JavascriptInterface
        fun requestOverlayPermission() {
            val activity = activityRef.get() ?: return
            try {
                val intent = Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION).apply {
                    data = Uri.parse("package:${activity.packageName}")
                }
                activity.startActivity(intent)
            } catch (e: Exception) {
                Log.e("TVVC", "Error launching ACTION_MANAGE_OVERLAY_PERMISSION", e)
            }
        }

        @android.webkit.JavascriptInterface
        fun requestFullScreenIntentPermission() {
            val activity = activityRef.get() ?: return
            try {
                if (Build.VERSION.SDK_INT >= 34) {
                    val intent = Intent("android.settings.MANAGE_APP_USE_FULL_SCREEN_INTENT").apply {
                        data = Uri.parse("package:${activity.packageName}")
                    }
                    activity.startActivity(intent)
                }
            } catch (e: Exception) {
                Log.e("TVVC", "Error launching ACTION_MANAGE_USE_FULL_SCREEN_INTENT", e)
            }
        }
    }

    override fun onBackPressed() {
        if (isCallActive) {
            showExitConfirmationDialog()
        } else {
            super.onBackPressed()
        }
    }

    private fun showExitConfirmationDialog() {
        android.app.AlertDialog.Builder(this)
            .setTitle("Exit Call?")
            .setMessage("Are you sure you want to hang up and exit the app?")
            .setPositiveButton("Exit") { _, _ ->
                webView.evaluateJavascript("if (window.hangUpCall) { window.hangUpCall(); }", null)
                finish()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (isCallActive) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val params = android.app.PictureInPictureParams.Builder().build()
                enterPictureInPictureMode(params)
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                @Suppress("DEPRECATION")
                enterPictureInPictureMode()
            }
        }
    }

    override fun onDestroy() {
        if (::webView.isInitialized) {
            webView.removeJavascriptInterface("AndroidBridge")
            (webView.parent as? android.view.ViewGroup)?.removeView(webView)
            webView.removeAllViews()
            webView.destroy()
        }
        super.onDestroy()
    }
}
