package app.gamebridgeforfun.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.sqrt

class LinearAccelerationFilterTest {
    @Test
    fun stationaryGravityDoesNotLookLikeShake() {
        val filter = LinearAccelerationFilter()

        val first = filter.filter(0.0, 0.0, 9.81)
        val second = filter.filter(0.0, 0.0, 9.81)

        assertEquals(0.0, magnitude(first), 0.0001)
        assertEquals(0.0, magnitude(second), 0.0001)
    }

    @Test
    fun suddenMovementStillProducesLinearAcceleration() {
        val filter = LinearAccelerationFilter()
        filter.filter(0.0, 0.0, 9.81)

        val movement = filter.filter(12.0, 0.0, 9.81)

        assertTrue(magnitude(movement) > 9.0)
    }

    @Test
    fun resetUsesNextFrameAsNewGravityBaseline() {
        val filter = LinearAccelerationFilter()
        filter.filter(0.0, 0.0, 9.81)
        filter.filter(12.0, 0.0, 9.81)

        filter.reset()
        val firstAfterReset = filter.filter(3.0, 4.0, 8.0)

        assertEquals(0.0, magnitude(firstAfterReset), 0.0001)
    }

    private fun magnitude(value: Triple<Double, Double, Double>): Double =
        sqrt(value.first * value.first + value.second * value.second + value.third * value.third)
}
