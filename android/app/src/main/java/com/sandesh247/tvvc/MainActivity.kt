package com.sandesh247.tvvc

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Build
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

        webView = WebView(this)
        setContentView(webView)

        webView.isFocusable = true
        webView.isFocusableInTouchMode = true
        webView.post {
            webView.requestFocus()
        }

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
        }

        // Register the JS bridge
        webView.addJavascriptInterface(AndroidBridge(), "AndroidBridge")

        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                isPageLoaded = true
                injectJsBridgeHelpers()
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

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        if (intent == null) {
            webView.loadUrl(BuildConfig.WEB_APP_URL)
            return
        }

        val action = intent.action
        val callId = intent.getStringExtra("callId")
        val callerId = intent.getStringExtra("callerId")

        Log.d("TVVC", "handleIntent: action=$action, callId=$callId, callerId=$callerId")

        if (action == "INCOMING_CALL" && !callId.isNullOrEmpty()) {
            val url = "${BuildConfig.WEB_APP_URL}?action=INCOMING_CALL&callId=${callId}&callerId=${callerId ?: ""}"
            Log.d("TVVC", "Loading intent URL: $url")
            webView.loadUrl(url)
        } else {
            Log.d("TVVC", "Loading default URL: ${BuildConfig.WEB_APP_URL}")
            webView.loadUrl(BuildConfig.WEB_APP_URL)
        }
    }

    private fun injectTokenIfAvailable() {
        val token = fcmToken ?: return
        if (isPageLoaded) {
            val js = """
                if (window.setFcmToken) {
                    window.setFcmToken('$token');
                }
            """.trimIndent()
            webView.evaluateJavascript(js, null)
        }
    }

    private fun injectJsBridgeHelpers() {
        val js = """
            (function() {
                var tokenInterval = setInterval(function() {
                    if (window.AndroidBridge && typeof window.setFcmToken === 'function') {
                        var token = window.AndroidBridge.getFcmToken();
                        if (token) {
                            window.setFcmToken(token);
                            clearInterval(tokenInterval);
                        }
                    }
                }, 100);

                setTimeout(function() {
                    clearInterval(tokenInterval);
                }, 20000);

                var lastUid = null;
                function checkIndexedDb() {
                    try {
                        var openRequest = indexedDB.open("firebaseLocalStorageDb");
                        openRequest.onsuccess = function(e) {
                            var db = e.target.result;
                            if (!db.objectStoreNames.contains("firebaseLocalStorage")) {
                                db.close();
                                return;
                            }
                            var transaction = db.transaction(["firebaseLocalStorage"], "readonly");
                            var store = transaction.objectStore("firebaseLocalStorage");
                            var getAllRequest = store.getAll();
                            getAllRequest.onsuccess = function(event) {
                                var items = event.target.result;
                                var uid = null;
                                if (items && items.length > 0) {
                                    for (var i = 0; i < items.length; i++) {
                                        var item = items[i];
                                        if (item && item.value) {
                                            var val = item.value;
                                            if (typeof val === 'string') {
                                                try {
                                                    val = JSON.parse(val);
                                                } catch(err) {}
                                            }
                                            if (val && val.uid) {
                                                uid = val.uid;
                                                break;
                                            }
                                        }
                                    }
                                }
                                if (uid !== lastUid) {
                                    lastUid = uid;
                                    window.AndroidBridge.syncUid(uid);
                                }
                                db.close();
                            };
                            getAllRequest.onerror = function() {
                                db.close();
                            };
                        };
                        openRequest.onerror = function() {};
                    } catch (e) {
                        console.error("IndexedDB error:", e);
                    }
                }
                setInterval(checkIndexedDb, 2000);
                checkIndexedDb();
            })();
        """.trimIndent()
        webView.evaluateJavascript(js, null)
    }

    inner class AndroidBridge {
        @android.webkit.JavascriptInterface
        fun syncUid(uid: String?) {
            val sharedPref = getSharedPreferences("TVVC_PREFS", android.content.Context.MODE_PRIVATE)
            if (!uid.isNullOrEmpty()) {
                sharedPref.edit().putString("auth_uid", uid).apply()
                Log.d("TVVC", "syncUid: saved auth_uid = $uid")
            } else {
                sharedPref.edit().remove("auth_uid").apply()
                Log.d("TVVC", "syncUid: removed auth_uid")
            }
        }

        @android.webkit.JavascriptInterface
        fun getFcmToken(): String? {
            return fcmToken
        }

        @android.webkit.JavascriptInterface
        fun onIncomingCallReceived(callId: String, callerId: String, callerName: String) {
            Log.d("TVVC", "onIncomingCallReceived via JS Bridge: callId=$callId, callerId=$callerId, callerName=$callerName")
            
            val serviceIntent = Intent(this@MainActivity, CallNotificationService::class.java).apply {
                putExtra("callId", callId)
                putExtra("callerId", callerId)
                putExtra("callerName", callerName)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(serviceIntent)
            } else {
                startService(serviceIntent)
            }

            // Attempt to bring app to foreground
            runOnUiThread {
                try {
                    val activityIntent = Intent(this@MainActivity, MainActivity::class.java).apply {
                        action = "INCOMING_CALL"
                        putExtra("callId", callId)
                        putExtra("callerId", callerId)
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    }
                    startActivity(activityIntent)
                } catch (e: Exception) {
                    Log.e("TVVC", "Error trying to launch activity on call start", e)
                }
            }
        }

        @android.webkit.JavascriptInterface
        fun cancelIncomingCallNotification() {
            Log.d("TVVC", "cancelIncomingCallNotification via JS Bridge")
            val intent = Intent(this@MainActivity, CallNotificationService::class.java)
            stopService(intent)
        }
    }
}
