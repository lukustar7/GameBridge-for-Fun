# Changelog

All notable changes to Lite will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and Lite follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- 修正 GitHub Pages 在线入口和部署说明，固定使用 `GameBridge-for-Fun-Lite/` 子目录。
- 修正直连版要求用户确认“硬件侧限幅”的错误文案，明确安全边界由网页 A/B 上限、设备物理停止和人工监护共同承担。

## [0.1.0-alpha.1] - 2026-07-31

### Added

- 新增独立 PWA 运行目录，五种玩法无需电脑网关即可从同源资源启动，运行时跨目录依赖降为 `0`。
- 新增 V2、V3 蓝牙服务识别和公开协议编码，覆盖 `2` 代硬件协议；未知服务在首次写入前即被拒绝。
- 新增 `17` 种固定波形和 `1` 种按时长筛选的随机模式，所有不足 `1 秒` 的输出统一提升到 `1 秒`。
- 新增三页移动端界面、全局通道与波形设置、权限重试、低强度试电和常驻急停。
- 新增版本化离线缓存和延迟更新流程，输出期间可激活更新的入口数量降为 `0`。
- 新增 GitHub Pages 自动部署检查，只上传 Lite 子目录，进入站点产物的原版运行文件数量为 `0`。

### Changed

- 将原版纯规则模块复制为 Lite 内部快照，保留五种玩法算法，同时解除对父目录和本地 Python 服务的运行依赖。
- 将蓝牙帧调度改为每 `100 ms` 串行发送，最大并发写入数固定为 `1`。
- 补充固定 GitHub Pages 在线入口与根许可证链接，公开同步后可直接进入 Lite 并核对许可。

### Fixed

- 修正旧原型中的 V2 强度位域、V3 `B0` 帧长度、持续时间未执行、页面隐藏未停止和传感器监听未清理问题。

### Security

- 新增连接变化后重新确认、A/B 双上限、传感器新鲜度、页面生命周期停止和会话代次隔离，旧回调可继续控制新玩法的路径降为 `0`。
- 新增单次输出墙钟截止时间；蓝牙写入变慢时丢弃过期帧，不再把 `1 秒` 请求补发成多秒任务。
