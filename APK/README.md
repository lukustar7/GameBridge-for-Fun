# Android APK

`GameBridgeForFun-Android15-debug.apk` 是可直接安装的 Android 15+ 调试签名包，不需要安装网页 HTTPS 根证书。

电脑必须运行 `start.command`，设备 App 保持硬件连接，GameBridge for Fun APK 保持前台。每次重启电脑服务后，需要重新扫描控制台中的 Android APK 二维码。

`SHA256.txt` 用于核对 APK 文件是否完整。执行 `./verify.command` 或 `./android/build-debug.command` 会覆盖 APK 与校验值，并验证编译产物一致性和安装签名。
