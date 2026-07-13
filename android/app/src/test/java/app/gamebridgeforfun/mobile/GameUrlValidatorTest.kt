package app.gamebridgeforfun.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

class GameUrlValidatorTest {
    private val validUrl =
        "http://192.168.1.20:18080/static/game.html?ws=18081&token=abcdefghijklmnopqrstuvwx"

    @Test
    fun acceptsPrivateLanGameUrl() {
        val result = GameUrlValidator.parse(validUrl)

        assertTrue(result is GameUrlResult.Success)
        val connection = (result as GameUrlResult.Success).connection
        assertEquals("192.168.1.20", connection.host)
        assertEquals(18080, connection.httpPort)
        assertEquals(18081, connection.webSocketPort)
    }

    @Test
    fun acceptsConsoleDeepLink() {
        val encoded = URLEncoder.encode(validUrl, StandardCharsets.UTF_8.name())
        val result = GameUrlValidator.parse("gamebridgeforfun://connect?url=$encoded")

        assertTrue(result is GameUrlResult.Success)
    }

    @Test
    fun rejectsPublicAddress() {
        val result = GameUrlValidator.parse(
            "http://8.8.8.8:18080/static/game.html?ws=18081&token=abcdefghijklmnopqrstuvwx"
        )

        assertTrue(result is GameUrlResult.Error)
    }

    @Test
    fun rejectsWrongPathAndMissingToken() {
        val wrongPath = GameUrlValidator.parse(
            "http://192.168.1.20:18080/static/index.html?ws=18081&token=abcdefghijklmnopqrstuvwx"
        )
        val missingToken = GameUrlValidator.parse(
            "http://192.168.1.20:18080/static/game.html?ws=18081"
        )

        assertTrue(wrongPath is GameUrlResult.Error)
        assertTrue(missingToken is GameUrlResult.Error)
    }

    @Test
    fun rejectsMalformedEscapeWithoutCrashing() {
        val result = GameUrlValidator.parse(
            "http://192.168.1.20:18080/static/game.html?ws=18081&token=%ZZ"
        )

        assertTrue(result is GameUrlResult.Error)
    }
}
