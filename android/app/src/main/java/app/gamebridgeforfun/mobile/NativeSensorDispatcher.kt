package app.gamebridgeforfun.mobile

import android.app.Activity
import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.view.Surface
import android.webkit.WebView
import java.util.Locale
import kotlin.math.atan2
import kotlin.math.sqrt

/**
 * 把 Android 原生方向和动作传感器压成浏览器游戏需要的一帧数据。
 *
 * 原生层只向已加载的本地游戏页单向注入数值，不向 JavaScript 暴露任何系统能力，
 * 从根源上避免 addJavascriptInterface 被不可信页面调用的安全风险。
 */
class NativeSensorDispatcher(
    private val activity: Activity,
    private val webView: WebView,
    private val canDispatch: () -> Boolean,
) : SensorEventListener {
    private val sensorManager = activity.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val rotationSensor = sensorManager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
    private val linearAccelerationSensor = sensorManager.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION)
    private val accelerometerSensor = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
    // 没有旋转矢量时必须选加速度计，因为它同时承担倾斜角兜底；只选线性加速度会永远算不出方向。
    private val motionSensor = if (rotationSensor == null) {
        accelerometerSensor
    } else {
        linearAccelerationSensor ?: accelerometerSensor
    }

    val hasOrientationSensor: Boolean
        get() = rotationSensor != null || accelerometerSensor != null

    val hasMotionSensor: Boolean
        get() = motionSensor != null

    private val rotationMatrix = FloatArray(9)
    private val adjustedRotationMatrix = FloatArray(9)
    private val orientation = FloatArray(3)
    private val accelerationFilter = LinearAccelerationFilter()

    private var beta = 0.0
    private var gamma = 0.0
    private var accelerationX = 0.0
    private var accelerationY = 0.0
    private var accelerationZ = 0.0
    private var orientationReady = false
    private var motionReady = false
    private var running = false
    private var lastDispatchNanos = 0L

    /** 只在 Activity 位于前台且游戏页完成加载后注册传感器。 */
    fun start() {
        if (running) return
        running = true
        rotationSensor?.let {
            sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_GAME)
        }
        motionSensor?.let {
            sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_GAME)
        }
    }

    /** 切后台时立即注销，既省电，也确保后台不会继续驱动游戏。 */
    fun stop() {
        if (!running) return
        running = false
        sensorManager.unregisterListener(this)
        orientationReady = false
        motionReady = false
        lastDispatchNanos = 0L
        accelerationFilter.reset()
    }

    override fun onSensorChanged(event: SensorEvent) {
        when (event.sensor.type) {
            Sensor.TYPE_ROTATION_VECTOR -> updateOrientationFromRotationVector(event.values)
            Sensor.TYPE_LINEAR_ACCELERATION -> updateMotion(event.values, includeFallbackOrientation = false)
            Sensor.TYPE_ACCELEROMETER -> updateMotionFromAccelerometer(
                event.values,
                includeFallbackOrientation = rotationSensor == null,
            )
        }

        // WebView 每秒最多接收约 30 帧，避免高频 evaluateJavascript 堵塞 UI 主线程。
        if (event.timestamp - lastDispatchNanos < 33_000_000L) return
        if (!orientationReady && !motionReady) return
        lastDispatchNanos = event.timestamp
        dispatchLatestFrame()
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    private fun updateOrientationFromRotationVector(values: FloatArray) {
        SensorManager.getRotationMatrixFromVector(rotationMatrix, values)
        val (axisX, axisY) = axesForDisplayRotation()
        SensorManager.remapCoordinateSystem(
            rotationMatrix,
            axisX,
            axisY,
            adjustedRotationMatrix,
        )
        SensorManager.getOrientation(adjustedRotationMatrix, orientation)

        // Android pitch/roll 与浏览器 beta/gamma 的正方向不同；这里只做符号对齐。
        beta = Math.toDegrees((-orientation[1]).toDouble())
        gamma = Math.toDegrees(orientation[2].toDouble())
        orientationReady = true
    }

    private fun updateMotion(values: FloatArray, includeFallbackOrientation: Boolean) {
        accelerationX = values.getOrElse(0) { 0f }.toDouble()
        accelerationY = values.getOrElse(1) { 0f }.toDouble()
        accelerationZ = values.getOrElse(2) { 0f }.toDouble()
        motionReady = true

        if (includeFallbackOrientation) {
            // 极少数没有旋转矢量传感器的设备，用重力方向近似计算前后与左右倾斜。
            val horizontal = sqrt(accelerationY * accelerationY + accelerationZ * accelerationZ)
            val vertical = sqrt(accelerationX * accelerationX + accelerationZ * accelerationZ)
            beta = Math.toDegrees(atan2(-accelerationY, vertical))
            gamma = Math.toDegrees(atan2(accelerationX, horizontal))
            orientationReady = true
        }
    }

    private fun updateMotionFromAccelerometer(values: FloatArray, includeFallbackOrientation: Boolean) {
        val rawX = values.getOrElse(0) { 0f }.toDouble()
        val rawY = values.getOrElse(1) { 0f }.toDouble()
        val rawZ = values.getOrElse(2) { 0f }.toDouble()
        val (linearX, linearY, linearZ) = accelerationFilter.filter(rawX, rawY, rawZ)
        accelerationX = linearX
        accelerationY = linearY
        accelerationZ = linearZ
        motionReady = true

        if (includeFallbackOrientation) {
            // 倾斜角仍需使用包含重力的原始值；摇晃强度则只使用上面去重力后的分量。
            val horizontal = sqrt(rawY * rawY + rawZ * rawZ)
            val vertical = sqrt(rawX * rawX + rawZ * rawZ)
            beta = Math.toDegrees(atan2(-rawY, vertical))
            gamma = Math.toDegrees(atan2(rawX, horizontal))
            orientationReady = true
        }
    }

    private fun dispatchLatestFrame() {
        if (!canDispatch()) return
        val script = String.format(
            Locale.US,
            "window.GameBridgeForFunNative&&window.GameBridgeForFunNative.receiveSensorFrame(%.5f,%.5f,%.5f,%.5f,%.5f,%b,%b);",
            beta,
            gamma,
            accelerationX,
            accelerationY,
            accelerationZ,
            orientationReady,
            motionReady,
        )
        webView.evaluateJavascript(script, null)
    }

    private fun axesForDisplayRotation(): Pair<Int, Int> {
        val displayRotation = activity.display?.rotation ?: Surface.ROTATION_0

        return when (displayRotation) {
            Surface.ROTATION_90 -> SensorManager.AXIS_Y to SensorManager.AXIS_MINUS_X
            Surface.ROTATION_180 -> SensorManager.AXIS_MINUS_X to SensorManager.AXIS_MINUS_Y
            Surface.ROTATION_270 -> SensorManager.AXIS_MINUS_Y to SensorManager.AXIS_X
            else -> SensorManager.AXIS_X to SensorManager.AXIS_Y
        }
    }
}
