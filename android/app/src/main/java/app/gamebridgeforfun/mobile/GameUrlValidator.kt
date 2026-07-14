package app.gamebridgeforfun.mobile

import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

/**
 * 经过严格校验的电脑游戏页连接信息。
 *
 * APK 只接受本地私有 IPv4、固定游戏页路径、合法 WS 端口和本次运行生成的 token。
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
                if (!outerUri.host.equals(CONNECT_HOST, ignoreCase = true) ||
                    outerUri.userInfo != null ||
                    outerUri.port != -1 ||
                    !outerUri.path.isNullOrEmpty() ||
                    outerUri.fragment != null
                ) {
                    return GameUrlResult.Error("APK 配对链接格式不正确。")
                }
                val outerQuery = parseQuery(outerUri.rawQuery)
                if (outerQuery.keys != setOf("url")) {
                    return GameUrlResult.Error("APK 配对链接包含多余或重复字段，请重新扫码。")
                }
                outerQuery["url"]
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
            return GameUrlResult.Error("游戏地址包含损坏或重复字段，请重新扫码。")
        }
        if (query.keys != setOf("ws", "token")) {
            return GameUrlResult.Error("游戏地址字段不完整或被修改，请重新扫码。")
        }
        val webSocketPort = query["ws"]?.toIntOrNull()
            ?: return GameUrlResult.Error("游戏地址缺少网页通信端口。")
        if (webSocketPort !in 1..65535) {
            return GameUrlResult.Error("网页通信端口无效。")
        }

        val token = query["token"].orEmpty()
        if (!tokenPattern.matches(token)) {
            return GameUrlResult.Error("游戏链接已损坏或缺少本次运行的 token，请重新扫码。")
        }

        // 重新构造地址并规范化字段顺序，确保 WebView 只收到已经逐项校验的可信内容。
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
            // 拒绝 001 这类历史八进制歧义写法，确保校验器与网络栈理解的是同一个地址。
            if (part.length > 1 && part.startsWith('0')) return false
            part.toIntOrNull()?.takeIf { it in 0..255 } ?: return false
        }

        return numbers[0] == 10 ||
            (numbers[0] == 172 && numbers[1] in 16..31) ||
            (numbers[0] == 192 && numbers[1] == 168)
    }

    private fun parseQuery(rawQuery: String?): Map<String, String> {
        if (rawQuery.isNullOrBlank()) return emptyMap()
        val result = linkedMapOf<String, String>()
        rawQuery.split('&').forEach { pair ->
            val separator = pair.indexOf('=')
            if (separator <= 0) throw IllegalArgumentException("查询字段格式错误")
            val key = decode(pair.substring(0, separator))
            val value = decode(pair.substring(separator + 1))
            // 重复字段在不同解析层可能产生“取第一个”或“取最后一个”的歧义，直接拒绝最安全。
            if (key.isBlank() || result.put(key, value) != null) {
                throw IllegalArgumentException("查询字段重复或为空")
            }
        }
        return result
    }

    private fun decode(value: String): String =
        URLDecoder.decode(value, StandardCharsets.UTF_8.name())

    private fun encode(value: String): String =
        URLEncoder.encode(value, StandardCharsets.UTF_8.name())
}
