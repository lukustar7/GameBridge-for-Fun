# GameBridge for Fun

本项目提供一个本地局域网游戏桥接服务，用于将手机网页小游戏的判定结果转发到兼容设备 App。

## 功能范围

- 电脑端控制台展示 App 绑定二维码、手机游戏二维码、手机 HTTPS 证书安装入口、局域网地址、端口和延迟状态。
- 电脑端和手机选择页展示端口、连接、延迟、强度、限幅与设备电量接入状态；当前桥接库未暴露电量读取时显示“未接入”。
- 电脑端和手机选择页提供连接自检、安全试电和停止输出入口；试电由后端强制限制强度、时长和冷却。
- 手机端包含手抖挑战、保持角度、摇骰子对决、极速角子机四个小游戏，每个游戏拥有独立参数配置、输出通道选择、字段说明和玩法说明。
- 手抖挑战、保持角度、摇骰子对决和极速角子机均支持按玩法配置输出节奏，避免连续输出叠得过密。
- 后端通过已锁定版本的第三方桥接库接入设备 App，统一执行 A/B 通道强度限幅、时长限制、请求限流和停止输出。
- 后端只允许本机控制台读取运行 token；静态服务仅公开 `static/` 与两份根证书下载文件，不公开源码、Git 元数据或证书私钥。
- Android APK 使用原生动作传感器打开同一套网页游戏逻辑，通过私有局域网 HTTP/WS 连接电脑，不需要安装网页根证书。

## 启动方式

macOS 双击运行：

```bash
./start.command
```

依赖版本已匹配时，`start.command` 直接启动服务；只有缺少或版本不符时才访问清华镜像安装。

命令行运行：

```bash
python3 -m pip install -r requirements.txt
python3 server.py
```

服务启动后会自动打开电脑端控制台。手机和电脑必须处于同一局域网。

如果电脑端二维码为空，先确认 `start.command` 的终端窗口仍在运行，再刷新控制台页面；页面会显示后台通信离线、二维码库加载失败或二维码生成失败的具体提示。

详细使用流程、玩法规则、证书安装和安全事项见 `USER_GUIDE.md`。

可选环境变量：

- `GAME_BRIDGE_FOR_FUN_CERT_IP`：覆盖自动检测到的证书签发 IP，仅接受 `10.x`、`172.16-31.x` 或 `192.168.x` IPv4。
- `GAME_BRIDGE_FOR_FUN_ROOT_CA_DAYS`：设置本地根证书有效天数，默认 `90`。
- `GAME_BRIDGE_FOR_FUN_SERVER_CERT_DAYS`：设置服务器证书有效天数，默认 `7`。
- `GAME_BRIDGE_FOR_FUN_NO_BROWSER`：设为 `1` 时启动服务但不自动打开浏览器，仅用于自动验收。

本地校验：

```bash
./verify.command
```

该脚本依次执行 Python、浏览器规则、Android、完整服务冒烟和 Git 差异检查。

## Android APK

APK 要求 Android 15 或更高版本，包名为 `app.gamebridgeforfun.mobile`。电脑控制台会生成 `gamebridgeforfun://connect` 配对二维码，APK 只接受私有 IPv4、固定游戏路径、合法端口和本次服务运行生成的 token。

使用 Android Studio 打开 `android/`，或在 macOS 执行：

```bash
./android/build-debug.command
```

可安装 APK 输出到 `APK/GameBridgeForFun-Android15-debug.apk`，SHA-256 校验值位于 `APK/SHA256.txt`。使用时需要电脑桥接服务、设备 App 和 GameBridge for Fun APK 同时在线；APK 必须保持前台，切后台或锁屏会立即断开并请求停止输出。

## 手机 HTTPS 证书

手抖挑战和保持角度依赖手机动作与方向感应权限，手机端建议使用 HTTPS 游戏入口。

服务启动时会自动检测当前局域网 IP，并为该 IP 签发 7 天有效的服务器证书；本地根证书默认 90 天有效。

控制台“手机证书”页提供 iPhone 描述文件、Android `.cer` 文件、证书指纹、到期时间和 HTTPS 游戏二维码。

iPhone 安装描述文件后，还需进入 `设置 > 通用 > 关于本机 > 证书信任设置`，手动开启 `GameBridge for Fun Local Root CA` 的完全信任。

证书私钥保存在 `certs/private/`，不得复制到手机或发送给他人；该目录已被 Git 忽略。

## 目录

- `server.py`：HTTP 静态服务、WebSocket 中转、设备 App 桥接与脉冲下发。
- `static/index.html`：电脑端控制台。
- `static/game.html`：手机端小游戏和独立设置页。
- `static/game.js`：页面交互、传感器处理、参数持久化与惩罚上报。
- `static/game-logic.js`：浏览器与 Node 测试共用的纯游戏规则。
- `android/`：Android APK、原生传感器桥接、安全 WebView 和地址校验测试。
- `APK/`：可直接安装的 Android 15+ 调试包、校验值和简要安装说明。
- `tests/test_server.py`：HTTP/WS 访问边界、硬件限幅与输出调度回归测试。
- `tests/test_game_logic.js`：骰子、角子机、配置恢复和传感器时效规则测试。
- `USER_GUIDE.md`：面向使用者的完整操作手册。
- `coyote/`：兼容设备的脉冲协议参考文档。

## 安全边界

本项目仅面向本地局域网使用。电脑控制台 WebSocket 仅接受本机页面，游戏端 WebSocket 使用本次服务运行生成的 token 校验；设备 App 配对二维码、运行 token 和证书详情只向本机控制台发送。

App 尚未回传通道限幅或限幅为 0 时，后端拒绝对应输出；A+B 模式要求两路限幅都有效。所有硬件输出最多只运行 1 个任务，重叠请求不会进入等待队列。

连接测试只用于确认链路和通道，不替代人工确认。安全试电最高强度为 30，最长 1 秒，并带有后端冷却。

手机端离开网页、页面进入后台、刷新或 WebSocket 断开时会主动请求停止输出；服务端也会在游戏连接断开时兜底清空 A/B 两路输出。

游戏输出期间必须持续收到所属页面的应用层心跳；长时结算超过 3.5 秒没有续报时，后端会取消任务并强制清空 A/B。持续型玩法超过 0.75 秒没有新脉冲时会自动归零，普通网络心跳不能替脉冲续期；传感器数据超过 1.6 秒未更新时也会立即请求停止并重新计时。

手机选择页展示紧急停止方式和 A/B 通道说明。游戏页可选择只用 A、只用 B 或 A+B 同时输出，但不直接修改波形、软上限或平衡参数。
