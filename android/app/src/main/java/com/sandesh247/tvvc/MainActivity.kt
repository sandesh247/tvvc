package com.sandesh247.tvvc

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.Build
import android.provider.Settings
import android.telecom.TelecomManager
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
import com.google.firebase.crashlytics.FirebaseCrashlytics
import com.sandesh247.tvvc.BuildConfig

class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private var fcmToken: String? = null
    private var isPageLoaded = false
    private var isCallActive = false
    private var pendingCallAction: String? = null
    private var isAppReady = false

    private var audioFocusRequest: android.media.AudioFocusRequest? = null
    private val audioFocusChangeListener = android.media.AudioManager.OnAudioFocusChangeListener { focusChange ->
        android.util.Log.d("TVVC", "Audio focus changed: $focusChange")
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        showOverLockscreenAndWake()

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

        // Register our PhoneAccount with TelecomManager so the system recognises us
        // as a self-managed calling app. This is idempotent and must happen before
        // any incoming call can be routed through ConnectionService.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                val telecomManager = getSystemService(Context.TELECOM_SERVICE) as TelecomManager
                MyFirebaseMessagingService.ensurePhoneAccountRegistered(this, telecomManager)
            } catch (e: Exception) {
                Log.e("TVVC", "Failed to register PhoneAccount on startup", e)
            }
        }

        // Wrap the WebView in a FrameLayout because WebView does not reliably support setPadding.
        // We apply the WindowInsets to the FrameLayout instead.
        val rootLayout = android.widget.FrameLayout(this).apply {
            // Note: This color matches the '--bg-main' CSS variable defined in
            // web/src/index.css so that the system status bar blends seamlessly
            // with the React web app's top navigation bar.
            setBackgroundColor(android.graphics.Color.parseColor("#0B0F19"))
        }
        
        webView = WebView(this)
        rootLayout.addView(
            webView,
            android.widget.FrameLayout.LayoutParams(
                android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                android.view.ViewGroup.LayoutParams.MATCH_PARENT
            )
        )
        
        setContentView(rootLayout)

        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(rootLayout) { view, windowInsets ->
            val insets = windowInsets.getInsets(androidx.core.view.WindowInsetsCompat.Type.systemBars())
            view.setPadding(insets.left, insets.top, insets.right, insets.bottom)
            windowInsets
        }

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
        showOverLockscreenAndWake()
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
            // Disconnect the active TelecomManager Connection (if any)
            CallConnection.cancelActiveConnection(callId)
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

            // Set the TelecomManager Connection to active (if routed through ConnectionService)
            CallConnection.activeConnection?.setActive()

            // Also stop the legacy CallNotificationService if it was somehow running
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
            // Disconnect the TelecomManager Connection if active
            CallConnection.activeConnection?.let { conn ->
                conn.setDisconnected(android.telecom.DisconnectCause(android.telecom.DisconnectCause.LOCAL))
                conn.destroy()
                CallConnection.activeConnection = null
            }
            // Also stop legacy service
            val intent = Intent(activity, CallNotificationService::class.java)
            activity.stopService(intent)
        }

        @android.webkit.JavascriptInterface
        fun setSpeakerphoneOn(on: Boolean) {
            val activity = activityRef.get() ?: return
            if (activity.isTvDevice()) {
                android.util.Log.d("TVVC", "setSpeakerphoneOn: Skipping routing change on Android TV device")
                return
            }
            android.util.Log.d("TVVC", "setSpeakerphoneOn: $on")
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
                if (active) {
                    // Set the TelecomManager Connection to active state
                    CallConnection.activeConnection?.setActive()
                    activity.requestCallAudioFocus(audioManager)
                    audioManager.mode = android.media.AudioManager.MODE_IN_COMMUNICATION
                } else {
                    audioManager.mode = android.media.AudioManager.MODE_NORMAL
                    activity.abandonCallAudioFocus(audioManager)
                    // Disconnect the TelecomManager Connection when the call ends
                    CallConnection.activeConnection?.let { conn ->
                        conn.setDisconnected(android.telecom.DisconnectCause(android.telecom.DisconnectCause.LOCAL))
                        conn.destroy()
                        CallConnection.activeConnection = null
                    }
                }
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
        fun isTvDevice(): Boolean {
            val activity = activityRef.get() ?: return false
            return activity.isTvDevice()
        }

        @android.webkit.JavascriptInterface
        fun logError(message: String, stackTrace: String) {
            android.util.Log.e("TVVC", "JS Error: $message\n$stackTrace")
            try {
                val crashlytics = FirebaseCrashlytics.getInstance()
                crashlytics.setCustomKey("js_stacktrace", stackTrace)
                val exception = Exception(message)
                
                // Parse stackTrace lines to reconstruct stackTraceElements
                val lines = stackTrace.split("\n")
                val stackElements = lines.mapNotNull { line ->
                    try {
                        val trimmed = line.trim()
                        if (trimmed.startsWith("at ")) {
                            val content = trimmed.substring(3)
                            val hasOpen = content.contains('(')
                            val hasClose = content.contains(')')
                            if ((hasOpen && !hasClose) || (!hasOpen && hasClose)) {
                                null
                            } else {
                                val parenStart = content.indexOf('(')
                                val parenEnd = content.indexOf(')')
                                if (hasOpen && hasClose && parenEnd < parenStart) {
                                    null
                                } else {
                                    val (func, filePart) = if (parenStart != -1 && parenEnd != -1) {
                                        Pair(content.substring(0, parenStart).trim(), content.substring(parenStart + 1, parenEnd).trim())
                                    } else {
                                        Pair("anonymous", content)
                                    }
                                    val parts = filePart.split(":")
                                    if (parts.size >= 2) {
                                        val lineNumber = parts[parts.size - 2].toIntOrNull() ?: 0
                                        val fileName = parts.subList(0, parts.size - 2).joinToString(":").substringAfterLast("/")
                                        val cleanFileName = fileName.trim()
                                        if (cleanFileName.isNotBlank() && !cleanFileName.contains('(') && !cleanFileName.contains(')') && !cleanFileName.contains(':') && !cleanFileName.contains('[') && !cleanFileName.contains(']')) {
                                            StackTraceElement("JavaScript", func, cleanFileName, lineNumber)
                                        } else {
                                            null
                                        }
                                    } else {
                                        null
                                    }
                                }
                            }
                        } else {
                            null
                        }
                    } catch (e: Exception) {
                        null
                    }
                }
                if (stackElements.isNotEmpty()) {
                    exception.stackTrace = stackElements.toTypedArray()
                }
                crashlytics.recordException(exception)
            } catch (e: Exception) {
                android.util.Log.e("TVVC", "Failed to record JS exception in Crashlytics", e)
            }
        }

        @android.webkit.JavascriptInterface
        fun requestIgnoreBatteryOptimizations() {
            val activity = activityRef.get() ?: return
            try {
                val powerManager = activity.getSystemService(android.content.Context.POWER_SERVICE) as android.os.PowerManager
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !powerManager.isIgnoringBatteryOptimizations(activity.packageName)) {
                    val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                        data = Uri.parse("package:${activity.packageName}")
                    }
                    activity.startActivity(intent)
                }
            } catch (e: Exception) {
                Log.e("TVVC", "Error launching ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS", e)
            }
        }

        @android.webkit.JavascriptInterface
        fun requestOverlayPermission() {
            val activity = activityRef.get() ?: return
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(activity)) {
                    val intent = Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION).apply {
                        data = Uri.parse("package:${activity.packageName}")
                    }
                    activity.startActivity(intent)
                }
            } catch (e: Exception) {
                Log.e("TVVC", "Error launching ACTION_MANAGE_OVERLAY_PERMISSION", e)
            }
        }

        @android.webkit.JavascriptInterface
        fun requestFullScreenIntentPermission() {
            val activity = activityRef.get() ?: return
            try {
                if (Build.VERSION.SDK_INT >= 34) {
                    val notificationManager = activity.getSystemService(android.content.Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
                    if (!notificationManager.canUseFullScreenIntent()) {
                        val intent = Intent("android.settings.MANAGE_APP_USE_FULL_SCREEN_INTENT").apply {
                            data = Uri.parse("package:${activity.packageName}")
                        }
                        activity.startActivity(intent)
                    }
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

    internal fun isTvDevice(): Boolean {
        val uiModeManager = getSystemService(android.content.Context.UI_MODE_SERVICE) as android.app.UiModeManager
        return uiModeManager.currentModeType == android.content.res.Configuration.UI_MODE_TYPE_TELEVISION
    }

    private fun requestCallAudioFocus(audioManager: android.media.AudioManager) {
        try {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                val playbackAttributes = android.media.AudioAttributes.Builder()
                    .setUsage(android.media.AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
                
                audioFocusRequest = android.media.AudioFocusRequest.Builder(android.media.AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
                    .setAudioAttributes(playbackAttributes)
                    .setAcceptsDelayedFocusGain(false)
                    .setOnAudioFocusChangeListener(audioFocusChangeListener)
                    .build()
                    
                audioFocusRequest?.let {
                    val result = audioManager.requestAudioFocus(it)
                    android.util.Log.d("TVVC", "Requested VOIP Audio Focus. Result code: $result")
                }
            } else {
                @Suppress("DEPRECATION")
                val result = audioManager.requestAudioFocus(
                    audioFocusChangeListener,
                    android.media.AudioManager.STREAM_VOICE_CALL,
                    android.media.AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE
                )
                android.util.Log.d("TVVC", "Requested legacy Audio Focus. Result code: $result")
            }
        } catch (e: Exception) {
            android.util.Log.e("TVVC", "Failed to request Audio Focus", e)
        }
    }

    private fun abandonCallAudioFocus(audioManager: android.media.AudioManager) {
        try {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                audioFocusRequest?.let {
                    val result = audioManager.abandonAudioFocusRequest(it)
                    android.util.Log.d("TVVC", "Abandoned VOIP Audio Focus. Result code: $result")
                }
                audioFocusRequest = null
            } else {
                @Suppress("DEPRECATION")
                val result = audioManager.abandonAudioFocus(audioFocusChangeListener)
                android.util.Log.d("TVVC", "Abandoned legacy Audio Focus. Result code: $result")
            }
        } catch (e: Exception) {
            android.util.Log.e("TVVC", "Failed to abandon Audio Focus", e)
        }
    }

    private fun showOverLockscreenAndWake() {
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
            val keyguardManager = getSystemService(android.content.Context.KEYGUARD_SERVICE) as android.app.KeyguardManager
            keyguardManager.requestDismissKeyguard(this, null)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                android.view.WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                android.view.WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD or
                android.view.WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
            )
        }
    }
}
