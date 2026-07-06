# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-07-06

### Added
- 新增一键双击启动脚本 `start.command`，实现 macOS 环境下的依赖自检与服务自动拉起。
- 新增局域网 Web/WebSocket 控制台，支持展示 App 连接二维码、局域网 IP 与延迟 RTT 监控。
- 新增三个极简 Canvas/Web 网页小游戏（手抖挑战、保持角度、摇骰子对决）。
- 前端游戏集成 Web Audio API 骰子撞击音效合成器与 `navigator.vibrate` 物理震动反馈。
- 引入本地 `qrcode.min.js`，实现离线/弱网二维码极速渲染。
- 后端 Python 异步服务端，实现多服务端口防冲突分配与 V3 脉冲波形下发逻辑。
