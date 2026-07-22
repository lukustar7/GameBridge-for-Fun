#!/bin/bash
# macOS 自带 Bash 版本较旧，因此只使用 Bash 3.2 已支持的语法。
# 所有可能失败的步骤都由脚本明确处理，确保双击启动时能看到可执行的中文提示。
set -uo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$PROJECT_ROOT/.venv"
VENV_PYTHON="$VENV_DIR/bin/python"
TUNA_PYPI_MIRROR="https://pypi.tuna.tsinghua.edu.cn/simple"
TUNA_PYTHON_HELP="https://mirrors.tuna.tsinghua.edu.cn/help/python/"
OFFICIAL_PYPI_MIRROR="https://pypi.org/simple"

cd "$PROJECT_ROOT" || exit 1

pause_if_interactive() {
    # Finder 双击会打开新的终端窗口；失败时暂停，避免错误信息一闪而过。
    if [ -t 0 ]; then
        printf "\n按回车键关闭此窗口..."
        read -r _unused
    fi
}

fail() {
    printf "\n[失败] %s\n" "$1"
    pause_if_interactive
    exit 1
}

python_is_supported() {
    # 只检查标准库即可完成版本判断，不要求候选 Python 已经安装项目依赖。
    "$1" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1
}

find_base_python() {
    # 用户可显式指定解释器；随后兼容 PATH、Apple Silicon、Intel 和 python.org 安装路径。
    for candidate in \
        "${GAME_BRIDGE_FOR_FUN_PYTHON:-}" \
        "$(command -v python3 2>/dev/null || true)" \
        "/opt/homebrew/bin/python3" \
        "/usr/local/bin/python3" \
        "/Library/Frameworks/Python.framework/Versions/Current/bin/python3"; do
        if [ -n "$candidate" ] && [ -x "$candidate" ] && python_is_supported "$candidate"; then
            printf "%s" "$candidate"
            return 0
        fi
    done
    return 1
}

print_python_install_help() {
    printf "\n没有找到 Python 3.9 或更高版本。\n"
    printf "推荐安装稳定版 Python 3.12，然后重新双击 start.command。\n"
    printf "中国大陆下载说明：%s\n" "$TUNA_PYTHON_HELP"
    printf "官方备用下载页：https://www.python.org/downloads/macos/\n"
    printf "安装时请保留默认选项；不需要另外安装 Node.js、Java 或 Android Studio。\n"
}

echo "============================================="
echo "GameBridge for Fun - macOS 启动检查"
echo "============================================="

if [ "$(uname -s 2>/dev/null)" != "Darwin" ]; then
    fail "当前启动器只支持 macOS。"
fi
echo "[通过] 当前系统为 macOS"

if [ ! -f "$PROJECT_ROOT/server/macos_preflight.py" ] || [ ! -f "$PROJECT_ROOT/requirements.txt" ]; then
    fail "项目文件不完整，缺少 server/macos_preflight.py 或 requirements.txt。"
fi

if [ ! -w "$PROJECT_ROOT" ]; then
    fail "项目目录不可写。请把完整文件夹复制到当前用户的“文稿”目录后重试。"
fi

BASE_PYTHON="$(find_base_python || true)"
if [ -z "$BASE_PYTHON" ]; then
    print_python_install_help
    fail "Python 环境尚未就绪。"
fi
echo "[通过] 找到 $("$BASE_PYTHON" --version 2>&1)：$BASE_PYTHON"

# 虚拟环境只存放本项目依赖，既不修改系统 Python，也不会与其他 Python 软件互相影响。
if [ -d "$VENV_DIR" ]; then
    if [ ! -x "$VENV_PYTHON" ] || ! python_is_supported "$VENV_PYTHON"; then
        BROKEN_VENV="$PROJECT_ROOT/.venv-broken-$(date +%Y%m%d-%H%M%S)"
        if ! mv "$VENV_DIR" "$BROKEN_VENV"; then
            fail "旧的项目独立环境已经损坏，且无法移动到备份目录。"
        fi
        echo "[提醒] 已把损坏的旧环境保留到：$BROKEN_VENV"
    fi
fi

if [ ! -x "$VENV_PYTHON" ]; then
    echo "[配置] 首次运行，正在创建项目独立 Python 环境..."
    if ! "$BASE_PYTHON" -m venv "$VENV_DIR"; then
        print_python_install_help
        fail "无法创建项目独立环境，请安装 python.org 提供的 Python 3.12 后重试。"
    fi
fi
if ! python_is_supported "$VENV_PYTHON"; then
    fail "项目独立环境无法执行。请把完整项目文件夹复制到当前用户的“文稿”目录后重试。"
fi
echo "[通过] 项目独立 Python 环境可用"

if ! "$VENV_PYTHON" -m pip --version >/dev/null 2>&1; then
    echo "[配置] 正在修复项目独立环境中的 pip..."
    if ! "$VENV_PYTHON" -m ensurepip --upgrade; then
        fail "pip 修复失败，请重新安装 Python 3.12 后重试。"
    fi
fi

# 依赖完全匹配时不联网；首次安装或版本变化时，优先使用中国大陆的清华镜像。
if ! "$VENV_PYTHON" "$PROJECT_ROOT/server/macos_preflight.py" --check-dependencies >/dev/null 2>&1; then
    echo "[配置] 正在从清华 PyPI 镜像安装锁定依赖..."
    if ! "$VENV_PYTHON" -m pip install \
        --disable-pip-version-check \
        --no-cache-dir \
        --progress-bar off \
        --retries 3 \
        --timeout 20 \
        --index-url "$TUNA_PYPI_MIRROR" \
        --requirement "$PROJECT_ROOT/requirements.txt"; then
        echo "[提醒] 清华镜像连接失败。"
        if [ -t 0 ]; then
            printf "是否改用官方 PyPI 再试一次？输入 y 后回车，其他输入取消："
            read -r RETRY_WITH_OFFICIAL
        else
            RETRY_WITH_OFFICIAL=""
        fi
        case "$RETRY_WITH_OFFICIAL" in
            y|Y)
                "$VENV_PYTHON" -m pip install \
                    --disable-pip-version-check \
                    --no-cache-dir \
                    --progress-bar off \
                    --retries 2 \
                    --timeout 20 \
                    --index-url "$OFFICIAL_PYPI_MIRROR" \
                    --requirement "$PROJECT_ROOT/requirements.txt" \
                    || fail "官方 PyPI 也无法完成依赖安装，请检查网络后重试。"
                ;;
            *)
                fail "依赖尚未安装。请检查网络后重新启动。"
                ;;
        esac
    fi
fi

if ! "$VENV_PYTHON" "$PROJECT_ROOT/server/macos_preflight.py" --check-dependencies; then
    fail "依赖安装完成后仍未通过版本检查，请删除 .venv 文件夹后重试。"
fi

echo ""
echo "正在检查局域网、运行文件和 HTTPS 证书..."
if ! "$VENV_PYTHON" "$PROJECT_ROOT/server/macos_preflight.py" --prepare-runtime; then
    fail "启动前检查没有通过，服务未启动。请按上面的具体提示处理。"
fi

echo ""
"$VENV_PYTHON" "$PROJECT_ROOT/server/server.py"
SERVER_EXIT_CODE=$?
if [ "$SERVER_EXIT_CODE" -ne 0 ] && [ "$SERVER_EXIT_CODE" -ne 130 ]; then
    fail "服务异常退出，退出码为 $SERVER_EXIT_CODE。"
fi

echo "服务已安全停止。"
pause_if_interactive
