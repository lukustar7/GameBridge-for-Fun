# GameBridge for Fun Lite

当前版本：`0.1.0-beta.1`

在线使用：[https://lukustar7.github.io/GameBridge-for-Fun/GameBridge-for-Fun-Lite/](https://lukustar7.github.io/GameBridge-for-Fun/GameBridge-for-Fun-Lite/)

Lite 是无需电脑网关和配套 App、由浏览器直接连接特定电刺激体感设备的实验性 PWA。它独立保存运行文件，不会加载仓库上级目录中的原版代码。

本项目处于早期 Beta 阶段，仅部分功能完成实机验证。由于实机测试会消耗测试人员，暂未覆盖全部设备、玩法和极端情况。请从低强度开始，避免将软件自动保护作为唯一安全措施。

## 当前范围

- 支持具备 Web Bluetooth 的 Android Chromium 浏览器，按公开 V2、V3 蓝牙协议识别设备。
- 提供手抖挑战、保持角度、摇骰子对决、极速角子机和雷电极速五种玩法；字段、默认值和核心判定规则与电脑网关版对齐。
- 首次联网后缓存全部运行资源；离线时可启动已缓存版本，蓝牙和传感器均在本机处理。
- iPhone、iPad 的 Safari 不提供 Web Bluetooth，当前不能直接使用 Lite 连接设备。

## 使用

1. 使用 Android Chrome 或 Edge 打开上面的 HTTPS 页面。
2. 在“设备与安全”中连接设备，设置通道、B 通道比例、波形和网页 A/B 安全上限，再完成输出确认。
3. 分别使用 A、B 或 A+B 低强度试电验证实际接线，随后进入“选择玩法”。

完整权限说明、安装、离线更新和故障处理见 [USER_GUIDE.md](USER_GUIDE.md)。

## 本地开发

```sh
python3 -m http.server 4173 --directory GameBridge-for-Fun-Lite
```

打开 `http://localhost:4173`。直接双击 `index.html` 不能验证离线缓存，部分浏览器也不会开放蓝牙权限。

运行本项目独立检查：

```sh
./GameBridge-for-Fun-Lite/verify.command
```

## 部署边界

GitHub Pages 当前从仓库分支发布整个项目，Lite 固定使用 `GameBridge-for-Fun-Lite/` 子目录地址。原版源码、证书说明和 APK 不会被 Lite 页面加载或缓存。

## 直连限幅说明

Lite 绕过配套 App，因此不存在可以继续依赖的“App 内限幅”。页面中的 A/B 网页上限就是 Lite 的软件请求上限，所有玩法和试电在写入蓝牙前都会再次受它约束；B 通道还可以选择与 A 相同或按 A 的比例降低。

网页上限不能修改设备固件，也不能保证无线归零指令一定送达。开始前仍应确认设备电源或物理停止方式可立即触及，并由输出接收者或监护者掌握。更换设备、通道、波形或网页上限后，页面会撤销本次确认并要求重新核对。

## 安全

- 输出接收者必须是知情同意、能够立即停止设备的成年人；首次使用从低强度、单通道开始。
- 不得跨胸布置电极，不得用于头颈、破损皮肤、睡眠、饮酒、驾驶或无法自行停止的场景。
- 雷电极速仅限封闭并已清场的非公共区域；驾驶员、骑行者和载具操作者不得操作游戏，也不得成为输出接收者。
- 页面隐藏、连接断开、传感器超时、玩法切换和急停会请求归零，但软件不能替代设备物理停止和人工监护。
- 玩法中的角子机与骰子只用于无金钱娱乐，严禁赌博、押注、收费抽奖或财物输赢。

## 项目关系与许可

Lite 基于 DG-LAB 官方公开的 V2/V3 蓝牙协议资料开发，不使用官方 SDK，与相关品牌及官方项目不存在隶属、授权或背书关系。协议来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

项目源码沿用仓库根目录的 [PolyForm Noncommercial 1.0.0 许可](../LICENSE.md)，仅限非商业使用、修改和再分发。
