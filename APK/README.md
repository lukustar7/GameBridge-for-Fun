# Android APK

`GameBridgeForFun-Android15-v1.1.0-beta.2.apk` 是可直接安装的 Android 15+ 正式签名 Beta 包，不需要安装网页 HTTPS 根证书。

安装过旧调试签名包的手机必须先卸载旧包；Android 不允许不同签名直接覆盖，卸载会同步清除旧包内的本地游戏设置。

电脑必须运行 `start.command`，设备 App 保持硬件连接，GameBridge for Fun APK 保持前台。每次重启电脑服务后，需要重新扫描控制台中的 Android APK 二维码。

雷电极速需要设备具备 GPS/GNSS，并允许精确定位；APK 只把速度、精度和时间交给游戏页，不传入经纬度。无 GPS/GNSS 的设备仍可安装并使用其他四个玩法。

`SHA256.txt` 用于核对 APK 文件是否完整。`./verify.command` 只读核对公开包的内部版本、校验值和签名；只有维护者执行 `./android/build-release.command` 才会使用仓库外的正式密钥刷新安装包。

正式签名证书 SHA-256 指纹为 `23:03:2C:C4:AA:C2:28:F3:E9:D7:B7:79:29:B9:ED:53:DB:F6:8A:6E:5A:7E:B4:F8:B3:E7:87:C2:23:C2:CD:9E`。

正式签名保存在当前 Mac 用户的 `~/Library/Application Support/GameBridge for Fun/signing/`。该目录必须单独备份且不得上传；丢失后，旧用户将无法直接覆盖安装新版 APK。
