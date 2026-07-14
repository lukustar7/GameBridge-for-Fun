package app.gamebridgeforfun.mobile

/**
 * 在设备只有普通加速度计时，用低通估计重力并返回去除重力后的动作分量。
 *
 * 第一帧只用于建立重力基线并返回 0，避免 APK 刚打开时把静止的 9.8m/s² 误判为摇骰子。
 */
internal class LinearAccelerationFilter(
    private val gravityRetention: Double = 0.8,
) {
    private var initialized = false
    private var gravityX = 0.0
    private var gravityY = 0.0
    private var gravityZ = 0.0

    init {
        require(gravityRetention in 0.0..1.0) { "重力保留系数必须位于 0-1" }
    }

    fun filter(x: Double, y: Double, z: Double): Triple<Double, Double, Double> {
        if (!initialized) {
            gravityX = x
            gravityY = y
            gravityZ = z
            initialized = true
            return Triple(0.0, 0.0, 0.0)
        }

        val inputRetention = 1.0 - gravityRetention
        gravityX = gravityRetention * gravityX + inputRetention * x
        gravityY = gravityRetention * gravityY + inputRetention * y
        gravityZ = gravityRetention * gravityZ + inputRetention * z
        return Triple(x - gravityX, y - gravityY, z - gravityZ)
    }

    fun reset() {
        initialized = false
        gravityX = 0.0
        gravityY = 0.0
        gravityZ = 0.0
    }
}
