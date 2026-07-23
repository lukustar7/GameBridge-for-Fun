# 参与开发

本仓库保留 Python、浏览器、Android 和测试源码，允许在非商业目的下修改和再分发。提交贡献即表示贡献内容可以继续按根目录 `LICENSE.md` 发布。

## 环境

- macOS 与 Python 3.9 或更高版本。
- 普通启动执行 `./start.command`。
- 开发者可执行 `uv sync`，或使用启动器创建的 `.venv`。
- Android 开发需要 Android Studio、JDK 17 和项目指定的 Android SDK。

## 修改边界

- 服务端强度、时长、限流、令牌、设备状态和停止保护不得下放给前端决定。
- 新设备型号必须有公开协议依据和测试；未知型号继续拒绝输出。
- 不得提交证书、私钥、签名文件、局域网地址、运行 token 或个人配置。
- 第三方文件必须记录来源、版本和许可证。

## 验证

执行 `./verify.command`。涉及真实输出时，先完成无硬件测试，再从低强度、短时长和单通道开始实机验证。

提交信息使用 Conventional Commits，例如 `fix: stop output after game disconnect`。
