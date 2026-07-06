# DG-LAB 小游戏中转系统

本项目提供一个本地局域网中转服务，用于将手机网页小游戏的判定结果转发到 DG-LAB App 远控网关。

## 功能范围

- 电脑端控制台展示 App 绑定二维码、手机游戏二维码、局域网地址、端口和延迟状态。
- 手机端包含手抖挑战、保持角度、摇骰子对决三个小游戏，每个游戏拥有独立参数配置。
- 后端通过 `pydglab-ws` 接入 DG-LAB App，统一执行强度限幅、时长限制、请求限流和停止输出。

## 启动方式

macOS 双击运行：

```bash
./start.command
```

命令行运行：

```bash
python3 -m pip install -r requirements.txt
python3 server.py
```

服务启动后会自动打开电脑端控制台。手机和电脑必须处于同一局域网。

## 目录

- `server.py`：HTTP 静态服务、WebSocket 中转、DG-LAB App 桥接与脉冲下发。
- `static/index.html`：电脑端控制台。
- `static/game.html`：手机端小游戏和独立设置页。
- `static/game.js`：游戏逻辑、传感器处理、参数持久化与惩罚上报。
- `coyote/`：郊狼脉冲主机协议参考文档。

## 安全边界

本项目仅面向本地局域网使用。游戏端 WebSocket 连接使用一次性运行 token 校验，后端仍会对所有强度、时长和请求频率做硬限制。
