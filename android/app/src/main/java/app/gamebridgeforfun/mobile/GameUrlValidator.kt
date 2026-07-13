package app.gamebridgeforfun.mobile

import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

/**
 * 经过严格校验的电脑游戏页连接信息。
 *
 * APK 只接受本地私有 IPv4、固定游戏页路径、合法 WS 端口和一次性 token。
 * 这样即使其他应用伪造深链，也不能借本 APK 打开公网网页或任意局域网页面。
 */
data class GameConnection(
    val pageUrl: String,
    val host: String,
    val httpPort: Int,
    val webSocketPort: Int,
    val token: String,
)

sealed interface GameUrlResult {
    data class Success(val connection: GameConnection) : GameUrlResult
    data class Error(val message: String) : GameUrlResult
}

object GameUrlValidator {
    private const val CONNECT_SCHEME = "gamebridgeforfun"
    private const val CONNECT_HOST = "connect"
    private const val GAME_PATH = "/static/game.html"
    private val tokenPattern = Regex("^[A-Za-z0-9_-]{16,128}$")

    /** 同时支持电脑控制台生成的私有深链和手动粘贴的普通 HTTP 地址。 */
    fun parse(input: String): GameUrlResult {
        val trimmed = input.trim()
        if (trimmed.isEmpty()) {
            return GameUrlResult.Error("请扫描 APK 配对二维码，或粘贴电脑控制台显示的游戏地址。")
        }

        val candidate = try {
            val outerUri = URI(trimmed)
            if (outerUri.scheme.equals(CONNECT_SCHEME, ignoreCase = true)) {
                if (!outerUri.host.equals(CONNECT_HOST, ignoreCase = true)) {
                    return GameUrlResult.Error("APK 配对链接格式不正确。")
                }
                parseQuery(outerUri.rawQuery)["url"]
                    ?: return GameUrlResult.Error("APK 配对链接缺少游戏地址。")
            } else {
                trimmed
            }
        } catch (_: Exception) {
            return GameUrlResult.Error("无法识别连接地址，请回到电脑控制台重新扫码。")
        }

        return validateGameUrl(candidate)
    }

    private fun validateGameUrl(candidate: String): GameUrlResult {
        val uri = try {
            URI(candidate)
        } catch (_: Exception) {
            return GameUrlResult.Error("游戏地址格式不正确。")
        }

        if (!uri.scheme.equals("http", ignoreCase = true)) {
            return GameUrlResult.Error("APK 只接受电脑控制台生成的普通 HTTP 游戏地址。")
        }
        if (uri.userInfo != null || uri.fragment != null || uri.path != GAME_PATH) {
            return GameUrlResult.Error("游戏地址路径不正确，请勿手动修改二维码内容。")
        }

        val host = uri.host ?: return GameUrlResult.Error("游戏地址缺少电脑局域网 IP。")
        if (!isPrivateIpv4(host)) {
            return GameUrlResult.Error("只允许连接 10.x、172.16-31.x 或 192.168.x 局域网地址。")
        }

        val httpPort = if (uri.port == -1) 80 else uri.port
        if (httpPort !in 1..65535) {
            return GameUrlResult.Error("HTTP 端口无效。")
        }

        val query = try {
            parseQuery(uri.rawQuery)
        } catch (_: IllegalArgumentException) {
            return GameUrlResult.Error("游戏地址包含损坏的转义字符，请重新扫码。")
        }
        val webSocketPort = query["ws"]?.toIntOrNull()
            ?: return GameUrlResult.Error("游戏地址缺少网页通信端口。")
        if (webSocketPort !in 1..65535) {
            return GameUrlResult.Error("网页通信端口无效。")
        }

        val token = query["token"].orEmpty()
        if (!tokenPattern.matches(token)) {
            return GameUrlResult.Error("游戏链接已损坏或缺少一次性 token，请重新扫码。")
        }

        // 重新构造地址，丢弃未知参数和任何非标准写法，确保 WebView 只收到可信字段。
        val canonicalUrl = "http://$host:$httpPort$GAME_PATH" +
            "?ws=$webSocketPort&token=${encode(token)}"
        return GameUrlResult.Success(
            GameConnection(canonicalUrl, host, httpPort, webSocketPort, token)
        )
    }

    private fun isPrivateIpv4(host: String): Boolean {
        val parts = host.split('.')
        if (parts.size != 4) return false
        val numbers = parts.map { part ->
            if (part.isEmpty() || part.length > 3 || part.any { !it.isDigit() }) return false
            part.toIntOrNull()?.takeIf { it in 0..255 } ?: return false
        }

        return numbers[0] == 10 ||
            (numbers[0] == 172 && numbers[1] in 16..31) ||
            (numbers[0] == 192 && numbers[1] == 168)
    }

    private fun parseQuery(rawQuery: String?): Map<String, String> {
        if (rawQuery.isNullOrBlank()) return emptyMap()
        return rawQuery.split('&').mapNotNull { pair ->
            val separator = pair.indexOf('=')
            if (separator <= 0) return@mapNotNull null
            val key = decode(pair.substring(0, separator))
            val value = decode(pair.substring(separator + 1))
            key to value
        }.toMap()
    }

    private fun decode(value: String): String =
        URLDecoder.decode(value, StandardCharsets.UTF_8.name())

    private fun encode(value: String): String =
        URLEncoder.encode(value, StandardCharsets.UTF_8.name())
}
