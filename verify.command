#!/bin/bash
# GameBridge for Fun 本地总体验收：任何一步失败都会停止，避免带着已知问题继续交付。
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
PYTHON_CACHE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/gamebridge-pycache.XXXXXX")"
SMOKE_LOG="$(mktemp "${TMPDIR:-/tmp}/gamebridge-smoke.XXXXXX.log")"
SMOKE_PID=""

cleanup() {
    # 只清理由本脚本创建的临时进程和临时文件，不触碰项目源码、证书或 APK。
    if [ -n "$SMOKE_PID" ] && kill -0 "$SMOKE_PID" 2>/dev/null; then
        kill -TERM "$SMOKE_PID" 2>/dev/null || true
        wait "$SMOKE_PID" 2>/dev/null || true
    fi
    rm -rf "$PYTHON_CACHE_DIR"
    rm -f "$SMOKE_LOG"
}
trap cleanup EXIT INT TERM

cd "$PROJECT_ROOT"

echo "[1/5] 检查 Python 后端与 macOS 启动器"
bash -n start.command
PYTHONPYCACHEPREFIX="$PYTHON_CACHE_DIR" python3 -m py_compile server.py dglab_v4.py macos_preflight.py
python3 -m unittest discover -s tests -p 'test_*.py' -v

echo "[2/5] 检查浏览器代码与游戏规则"
if ! command -v node >/dev/null 2>&1; then
    echo "错误: 未找到 Node.js，无法执行浏览器规则测试。"
    exit 1
fi
node --check static/console.js
node --check static/game-logic.js
node --check static/game.js
node --test tests/test_game_logic.js

echo "[3/5] 检查 Android 并刷新已验签的调试安装包"
./android/build-debug.command

echo "[4/5] 启动完整服务并执行本机 HTTP 冒烟检查"
GAME_BRIDGE_FOR_FUN_NO_BROWSER=1 PYTHONUNBUFFERED=1 python3 server.py >"$SMOKE_LOG" 2>&1 &
SMOKE_PID=$!
SMOKE_PORT=""
SMOKE_READY=0

# 最多等待 10 秒；服务若提前退出则立即打印完整日志，避免只看到“连接失败”。
for _ in {1..50}; do
    if ! kill -0 "$SMOKE_PID" 2>/dev/null; then
        echo "错误: 服务在冒烟检查期间提前退出。"
        sed -n '1,240p' "$SMOKE_LOG"
        exit 1
    fi
    SMOKE_PORT="$(sed -n 's/.*HTTP 服务已启动: 端口 \([0-9][0-9]*\).*/\1/p' "$SMOKE_LOG" | tail -n 1)"
    if [ -n "$SMOKE_PORT" ]; then
        if /usr/bin/curl --fail --silent --show-error \
            "http://127.0.0.1:${SMOKE_PORT}/static/index.html" >/dev/null && \
            /usr/bin/curl --fail --silent --show-error \
            "http://127.0.0.1:${SMOKE_PORT}/static/game.html" >/dev/null && \
            /usr/bin/curl --fail --silent --show-error \
            "http://127.0.0.1:${SMOKE_PORT}/static/game-logic.js" >/dev/null; then
            SMOKE_READY=1
            break
        fi
    fi
    sleep 0.2
done

if [ "$SMOKE_READY" -ne 1 ]; then
    echo "错误: 10 秒内没有通过完整 HTTP 资源检查。"
    sed -n '1,240p' "$SMOKE_LOG"
    exit 1
fi

# 使用 TERM 验证终端关闭时会进入后端安全停机流程，而不是直接丢下活动输出。
kill -TERM "$SMOKE_PID"
if ! wait "$SMOKE_PID"; then
    echo "错误: 服务未能通过 TERM 信号正常完成安全退出。"
    sed -n '1,240p' "$SMOKE_LOG"
    exit 1
fi
SMOKE_PID=""

if ! grep -q "正在安全停止服务" "$SMOKE_LOG"; then
    echo "错误: 服务退出日志中没有安全停机确认。"
    sed -n '1,240p' "$SMOKE_LOG"
    exit 1
fi

echo "[5/5] 检查 Git 差异格式"
git diff --check

echo "本地总体验收通过。"
