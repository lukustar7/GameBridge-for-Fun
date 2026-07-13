package app.gamebridgeforfun.mobile

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.view.inputmethod.EditorInfo
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
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
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
    private var pageLoadFailed = false
    private var activityResumed = false
    private var reloadAfterResume = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        configureSystemInsets()
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
        binding.gameToolbar.setNavigationOnClickListener { returnToConnectionScreen() }
        binding.retryButton.setOnClickListener { retryCurrentConnection() }
        binding.gameUrlInput.setOnEditorActionListener { _, actionId, _ ->
            if (actionId != EditorInfo.IME_ACTION_GO) return@setOnEditorActionListener false
            hideKeyboard()
            connectFromInput(binding.gameUrlInput.text?.toString().orEmpty())
            true
        }
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
            is GameUrlResult.Error -> {
                // 无效深链可能在游戏进行中抵达；先回连接页，确保错误不会被隐藏在 WebView 后面。
                if (binding.gameContainer.isVisible) returnToConnectionScreen()
                showConnectionError(result.message)
            }
            is GameUrlResult.Success -> showGame(result.connection)
        }
    }

    private fun showGame(connection: GameConnection) {
        if (pageReady) evaluateNativeCommand("pause", "android_reconnect")
        sensorDispatcher.stop()
        trustedConnection = connection
        pageReady = false
        pageLoadFailed = false
        reloadAfterResume = false
        binding.connectionError.visibility = View.GONE
        binding.gameUrlInput.setText(connection.pageUrl)
        getPreferences(MODE_PRIVATE).edit {
            putString(PREF_LAST_GAME_URL, connection.pageUrl)
        }

        binding.connectionScroll.visibility = View.GONE
        binding.gameContainer.visibility = View.VISIBLE
        showPageLoading()
        binding.gameWebView.loadUrl(connection.pageUrl)
    }

    private fun returnToConnectionScreen() {
        if (pageReady) evaluateNativeCommand("pause", "android_back")
        sensorDispatcher.stop()
        pageReady = false
        pageLoadFailed = false
        reloadAfterResume = false
        trustedConnection = null
        binding.gameWebView.stopLoading()
        binding.gameWebView.loadUrl("about:blank")
        binding.gameWebView.clearHistory()
        binding.pageLoadingOverlay.visibility = View.GONE
        binding.pageErrorPanel.visibility = View.GONE
        binding.gameContainer.visibility = View.GONE
        binding.connectionScroll.visibility = View.VISIBLE
    }

    private fun showConnectionError(message: String) {
        binding.connectionError.text = message
        binding.connectionError.visibility = View.VISIBLE
    }

    private fun retryCurrentConnection() {
        val connection = trustedConnection ?: run {
            returnToConnectionScreen()
            return
        }
        pageReady = false
        pageLoadFailed = false
        showPageLoading()
        binding.gameWebView.stopLoading()
        binding.gameWebView.loadUrl(connection.pageUrl)
    }

    private fun showPageLoading() {
        binding.pageErrorPanel.visibility = View.GONE
        binding.pageLoadingOverlay.visibility = View.VISIBLE
    }

    private fun showPageError(message: String = getString(R.string.load_error_default)) {
        pageReady = false
        pageLoadFailed = true
        sensorDispatcher.stop()
        binding.pageLoadingOverlay.visibility = View.GONE
        binding.pageErrorText.text = message
        binding.pageErrorPanel.visibility = View.VISIBLE
    }

    private fun configureSystemInsets() {
        // Android 15 默认使用全面屏；把系统状态栏和导航栏空间交还给根视图统一处理。
        WindowCompat.setDecorFitsSystemWindows(window, false)
        ViewCompat.setOnApplyWindowInsetsListener(binding.root) { view, insets ->
            val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.setPadding(systemBars.left, systemBars.top, systemBars.right, systemBars.bottom)
            insets
        }
        ViewCompat.requestApplyInsets(binding.root)
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

    private fun hasTrustedOrigin(uri: Uri, connection: GameConnection): Boolean {
        val port = if (uri.port == -1) 80 else uri.port
        return uri.scheme.equals("http", ignoreCase = true) &&
            uri.host == connection.host &&
            port == connection.httpPort
    }

    private fun isAllowedMainFrame(uri: Uri): Boolean {
        val connection = trustedConnection ?: return false
        // 主文档必须与校验器重建出的规范地址完全一致，不能跳到同源控制台或其他静态页面。
        return hasTrustedOrigin(uri, connection) && uri.toString() == connection.pageUrl
    }

    private fun isAllowedStaticResource(uri: Uri): Boolean {
        val connection = trustedConnection ?: return false
        return hasTrustedOrigin(uri, connection) && uri.path in ALLOWED_STATIC_RESOURCES
    }

    private fun isAllowedWebRequest(uri: Uri): Boolean {
        return isAllowedMainFrame(uri) || isAllowedStaticResource(uri)
    }

    private inner class RestrictedGameWebViewClient : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            return request.isForMainFrame && !isAllowedMainFrame(request.url)
        }

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            if (isAllowedWebRequest(request.url)) return null
            return WebResourceResponse(
                "text/plain",
                "utf-8",
                ByteArrayInputStream("blocked".toByteArray()),
            )
        }

        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
            if (trustedConnection?.pageUrl != url) return
            pageReady = false
            pageLoadFailed = false
            sensorDispatcher.stop()
            showPageLoading()
        }

        override fun onPageFinished(view: WebView, url: String) {
            val connection = trustedConnection ?: return
            if (url != connection.pageUrl) return
            // 部分 WebView 在主文档失败后仍回调 onPageFinished，失败状态不能被这个迟到回调覆盖。
            if (pageLoadFailed) return
            pageReady = true
            binding.pageLoadingOverlay.visibility = View.GONE
            binding.pageErrorPanel.visibility = View.GONE
            evaluateNativeCommand("enable")
            if (activityResumed) sensorDispatcher.start()
        }

        override fun onReceivedError(
            view: WebView,
            request: WebResourceRequest,
            error: WebResourceError,
        ) {
            if (!request.isForMainFrame) return
            if (!activityResumed || trustedConnection == null) return
            showPageError()
        }

        override fun onReceivedHttpError(
            view: WebView,
            request: WebResourceRequest,
            errorResponse: WebResourceResponse,
        ) {
            if (!request.isForMainFrame || !activityResumed || trustedConnection == null) return
            showPageError("电脑服务返回 ${errorResponse.statusCode}，配对地址可能已经过期，请重新扫码。")
        }

        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            // APK 不使用 HTTPS 自签证书；意外跳转到 HTTPS 时绝不绕过系统校验。
            handler.cancel()
            if (activityResumed && trustedConnection != null) {
                showPageError("APK 不接受 HTTPS 页面，请回到电脑控制台重新扫描 Android APK 二维码。")
            }
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
            pageLoadFailed = true
            reloadAfterResume = false
            trustedConnection = null
            // 渲染进程已经死亡，旧 WebView 不能安全复用；重建 Activity 得到全新实例。
            binding.root.post { recreate() }
            return true
        }
    }

    companion object {
        private const val PREF_LAST_GAME_URL = "last_game_url"
        private val ALLOWED_STATIC_RESOURCES = setOf(
            "/static/game.js",
            "/static/style.css",
        )
    }
}
