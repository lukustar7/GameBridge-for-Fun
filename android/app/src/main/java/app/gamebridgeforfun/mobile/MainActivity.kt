package app.gamebridgeforfun.mobile

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.webkit.CookieManager
import android.webkit.SafeBrowsingResponse
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.net.http.SslError
import android.webkit.RenderProcessGoneDetail
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.edit
import androidx.core.view.isVisible
import app.gamebridgeforfun.mobile.databinding.ActivityMainBinding
import java.io.ByteArrayInputStream

/**
 * APK 唯一入口：负责接收电脑配对链接、限制 WebView 访问范围、管理原生传感器和停机生命周期。
 */
class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding
    private lateinit var sensorDispatcher: NativeSensorDispatcher
    private var trustedConnection: GameConnection? = null
    private var pageReady = false
    private var activityResumed = false
    private var reloadAfterResume = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        configureWebView()
        sensorDispatcher = NativeSensorDispatcher(this, binding.gameWebView) {
            pageReady && activityResumed && trustedConnection != null
        }
        bindActions()
        installBackHandler()
        handleIncomingIntent(intent, autoConnect = true)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIncomingIntent(intent, autoConnect = true)
    }

    override fun onResume() {
        super.onResume()
        activityResumed = true
        binding.gameWebView.onResume()
        val connection = trustedConnection
        if (reloadAfterResume && connection != null) {
            reloadAfterResume = false
            binding.gameWebView.loadUrl(connection.pageUrl)
        } else if (pageReady) {
            evaluateNativeCommand("resume")
            sensorDispatcher.start()
        }
    }

    override fun onPause() {
        // 必须先通知网页停机并关闭 WS，再暂停 WebView；顺序反过来可能让 JS 来不及发送停止请求。
        if (pageReady) evaluateNativeCommand("pause", "android_pause")
        sensorDispatcher.stop()
        if (trustedConnection != null) {
            // 销毁当前文档会从 WebView 网络层关闭 WS，作为 JS 停机消息之外的第二道硬兜底。
            pageReady = false
            reloadAfterResume = true
            binding.gameWebView.stopLoading()
            binding.gameWebView.loadUrl("about:blank")
            binding.gameWebView.clearHistory()
        }
        binding.gameWebView.onPause()
        activityResumed = false
        super.onPause()
    }

    override fun onDestroy() {
        sensorDispatcher.stop()
        binding.gameWebView.apply {
            stopLoading()
            loadUrl("about:blank")
            clearHistory()
            removeAllViews()
            destroy()
        }
        super.onDestroy()
    }

    private fun bindActions() {
        binding.connectButton.setOnClickListener {
            hideKeyboard()
            connectFromInput(binding.gameUrlInput.text?.toString().orEmpty())
        }
        binding.clearButton.setOnClickListener {
            binding.gameUrlInput.text?.clear()
            binding.connectionError.visibility = View.GONE
            getPreferences(MODE_PRIVATE).edit { remove(PREF_LAST_GAME_URL) }
        }
        binding.backToConnectButton.setOnClickListener { returnToConnectionScreen() }
    }

    private fun installBackHandler() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (binding.gameContainer.isVisible) {
                    returnToConnectionScreen()
                } else {
                    finish()
                }
            }
        })
    }

    private fun handleIncomingIntent(intent: Intent?, autoConnect: Boolean) {
        val deepLink = intent?.dataString
        if (!deepLink.isNullOrBlank() &&
            intent.data?.scheme.equals("gamebridgeforfun", ignoreCase = true)
        ) {
            binding.gameUrlInput.setText(deepLink)
            if (autoConnect) connectFromInput(deepLink)
            return
        }

        if (binding.gameUrlInput.text.isNullOrBlank()) {
            val savedUrl = getPreferences(MODE_PRIVATE).getString(PREF_LAST_GAME_URL, "").orEmpty()
            binding.gameUrlInput.setText(savedUrl)
        }
    }

    private fun connectFromInput(input: String) {
        when (val result = GameUrlValidator.parse(input)) {
            is GameUrlResult.Error -> showConnectionError(result.message)
            is GameUrlResult.Success -> showGame(result.connection)
        }
    }

    private fun showGame(connection: GameConnection) {
        if (pageReady) evaluateNativeCommand("pause", "android_reconnect")
        sensorDispatcher.stop()
        trustedConnection = connection
        pageReady = false
        reloadAfterResume = false
        binding.connectionError.visibility = View.GONE
        binding.gameUrlInput.setText(connection.pageUrl)
        getPreferences(MODE_PRIVATE).edit {
            putString(PREF_LAST_GAME_URL, connection.pageUrl)
        }

        binding.connectionScroll.visibility = View.GONE
        binding.gameContainer.visibility = View.VISIBLE
        binding.gameWebView.loadUrl(connection.pageUrl)
    }

    private fun returnToConnectionScreen() {
        if (pageReady) evaluateNativeCommand("pause", "android_back")
        sensorDispatcher.stop()
        pageReady = false
        reloadAfterResume = false
        trustedConnection = null
        binding.gameWebView.stopLoading()
        binding.gameWebView.loadUrl("about:blank")
        binding.gameWebView.clearHistory()
        binding.gameContainer.visibility = View.GONE
        binding.connectionScroll.visibility = View.VISIBLE
    }

    private fun showConnectionError(message: String) {
        binding.connectionError.text = message
        binding.connectionError.visibility = View.VISIBLE
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        CookieManager.getInstance().setAcceptCookie(false)
        CookieManager.getInstance().removeAllCookies(null)

        binding.gameWebView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setGeolocationEnabled(false)
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            mediaPlaybackRequiresUserGesture = true
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
            cacheMode = android.webkit.WebSettings.LOAD_NO_CACHE
            userAgentString = "$userAgentString GameBridgeForFun/1.1.0"
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        binding.gameWebView.webViewClient = RestrictedGameWebViewClient()
    }

    private fun evaluateNativeCommand(command: String, argument: String? = null) {
        if (!pageReady) return
        val argumentScript = argument?.let { "'${it.replace("'", "")}'" }.orEmpty()
        val call = if (argument == null) "$command()" else "$command($argumentScript)"
        binding.gameWebView.evaluateJavascript(
            "window.GameBridgeForFunNative&&window.GameBridgeForFunNative.$call;",
            null,
        )
    }

    private fun hideKeyboard() {
        val manager = getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager
        manager.hideSoftInputFromWindow(binding.gameUrlInput.windowToken, 0)
    }

    private fun isAllowedWebResource(uri: Uri): Boolean {
        val connection = trustedConnection ?: return false
        val port = if (uri.port == -1) 80 else uri.port
        return uri.scheme.equals("http", ignoreCase = true) &&
            uri.host == connection.host &&
            port == connection.httpPort &&
            (uri.path == "/static/game.html" || uri.path?.startsWith("/static/") == true)
    }

    private inner class RestrictedGameWebViewClient : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            return !isAllowedWebResource(request.url)
        }

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            if (isAllowedWebResource(request.url)) return null
            return WebResourceResponse(
                "text/plain",
                "utf-8",
                ByteArrayInputStream("blocked".toByteArray()),
            )
        }

        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
            pageReady = false
            sensorDispatcher.stop()
        }

        override fun onPageFinished(view: WebView, url: String) {
            val connection = trustedConnection ?: return
            if (url != connection.pageUrl) return
            pageReady = true
            evaluateNativeCommand("enable")
            if (activityResumed) sensorDispatcher.start()
        }

        override fun onReceivedError(
            view: WebView,
            request: WebResourceRequest,
            error: WebResourceError,
        ) {
            if (!request.isForMainFrame) return
            Toast.makeText(
                this@MainActivity,
                "无法连接电脑服务，请确认 start.command 正在运行且手机处于同一 Wi-Fi。",
                Toast.LENGTH_LONG,
            ).show()
        }

        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            // APK 不使用 HTTPS 自签证书；意外跳转到 HTTPS 时绝不绕过系统校验。
            handler.cancel()
        }

        override fun onSafeBrowsingHit(
            view: WebView,
            request: WebResourceRequest,
            threatType: Int,
            callback: SafeBrowsingResponse,
        ) {
            callback.backToSafety(true)
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            Toast.makeText(this@MainActivity, "游戏页面异常退出，已停止连接。", Toast.LENGTH_LONG).show()
            sensorDispatcher.stop()
            pageReady = false
            reloadAfterResume = false
            trustedConnection = null
            // 渲染进程已经死亡，旧 WebView 不能安全复用；重建 Activity 得到全新实例。
            binding.root.post { recreate() }
            return true
        }
    }

    companion object {
        private const val PREF_LAST_GAME_URL = "last_game_url"
    }
}
