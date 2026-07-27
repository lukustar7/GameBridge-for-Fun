package app.gamebridgeforfun.mobile

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Looper
import android.webkit.WebView
import java.util.Locale

/**
 * 通过 Android 原生 GPS/GNSS 读取速度，并向受信任的本地游戏页注入脱敏结果。
 *
 * 经纬度只存在于 Android 系统回调的短暂内存中；注入网页的字段只有速度、定位精度、
 * 速度精度和采样时间，电脑服务和 JavaScript 都拿不到行驶轨迹。
 */
class NativeLocationDispatcher(
    private val activity: Activity,
    private val webView: WebView,
    private val canDispatch: () -> Boolean,
) : LocationListener {
    private val locationManager = activity.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    private var running = false

    val hasGpsHardware: Boolean
        get() = activity.packageManager.hasSystemFeature(PackageManager.FEATURE_LOCATION_GPS) &&
            locationManager.allProviders.contains(LocationManager.GPS_PROVIDER)

    val locationServiceEnabled: Boolean
        get() = locationManager.isLocationEnabled

    val permissionGranted: Boolean
        get() = activity.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    /** 只有硬件、系统开关、运行时权限和受信任页面全部就绪时才注册定位。 */
    fun start() {
        if (running || !canDispatch() || !hasGpsHardware || !locationServiceEnabled || !permissionGranted) return
        try {
            locationManager.requestLocationUpdates(
                LocationManager.GPS_PROVIDER,
                500L,
                0f,
                this,
                Looper.getMainLooper(),
            )
            running = true
        } catch (_: SecurityException) {
            running = false
        } catch (_: IllegalArgumentException) {
            // 设备谎报 GPS provider 时保持关闭，由能力中心明确显示不可用。
            running = false
        }
    }

    /** 页面切后台、断开或 Activity 销毁时立即停止读取，避免后台持续定位。 */
    fun stop() {
        if (!running) return
        locationManager.removeUpdates(this)
        running = false
    }

    override fun onLocationChanged(location: Location) {
        if (!canDispatch() || !location.hasSpeed()) return
        val speedKmh = location.speed.toDouble() * 3.6
        val accuracyMeters = location.accuracy.toDouble()
        val speedAccuracyKmh = if (location.hasSpeedAccuracy()) {
            location.speedAccuracyMetersPerSecond.toDouble() * 3.6
        } else {
            -1.0
        }
        val script = String.format(
            Locale.US,
            "window.GameBridgeForFunNative&&window.GameBridgeForFunNative.receiveLocationSample(%.4f,%.2f,%.2f,%d);",
            speedKmh,
            accuracyMeters,
            speedAccuracyKmh,
            location.time,
        )
        webView.evaluateJavascript(script, null)
    }
}
