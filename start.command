#!/bin/bash
# 任何一步失败都立即退出，避免依赖没装好还继续启动服务。
set -e

# 切换工作目录为脚本所在的真实目录
cd "$(dirname "$0")"

echo "正在自检运行环境..."

# 检查 python3 是否存在
if ! command -v python3 &> /dev/null; then
    echo "错误: 未检测到 Python3，请先安装 Python 运行环境"
    exit 1
fi

# 已安装且版本完全匹配时直接启动，避免每次双击都访问镜像并等待网络响应。
if python3 -c 'import importlib.metadata as m; import pydglab_ws, websockets; assert m.version("pydglab-ws") == "1.1.0"; assert m.version("websockets") == "12.0"' 2>/dev/null; then
    echo "Python 依赖已就绪"
else
    echo "正在从清华镜像安装 Python 依赖..."
    python3 -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple --quiet
fi

# 启动服务端
python3 server.py
