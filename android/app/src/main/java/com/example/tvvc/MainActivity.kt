package com.sandesh247.tvvc

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.os.Bundle
import android.util.Log
import android.view.KeyEvent
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

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Request permissions
        if (!hasPermissions()) {
            ActivityCompat.requestPermissions(
                this,
                arrayOf(
                    Manifest.permission.CAMERA,
                    Manifest.permission.RECORD_AUDIO,
                    Manifest.permission.MODIFY_AUDIO_SETTINGS
                ),
                1
            )
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

        webView.webViewClient = WebViewClient()
        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                Log.d("TVVC", "Permission request: ${request.resources.joinToString()}")
                runOnUiThread {
                    request.grant(request.resources)
                }
            }
        }

        webView.loadUrl(BuildConfig.WEB_APP_URL)

        // Retrieve FCM Token and pass to WebView
        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
            if (!task.isSuccessful) {
                Log.w("TVVC", "Fetching FCM registration token failed", task.exception)
                return@addOnCompleteListener
            }

            val token = task.result
            Log.d("TVVC", "FCM Token: $token")
            
            val js = """
                window.tvvcFcmToken = '$token';
                if (window.setFcmToken) {
                    window.setFcmToken('$token');
                }
            """.trimIndent()
            
            webView.evaluateJavascript(js, null)
        }
    }

    private fun hasPermissions(): Boolean {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED &&
                ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
    }

    // Pass TV remote keys (like D-Pad Center) to the WebView
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_DPAD_CENTER || keyCode == KeyEvent.KEYCODE_ENTER) {
            // Can execute JS to simulate enter if needed, but WebView usually handles it
            Log.d("TVVC", "D-PAD CENTER PRESSED")
        }
        return super.onKeyDown(keyCode, event)
    }
}
