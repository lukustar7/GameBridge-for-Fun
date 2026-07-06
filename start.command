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

# 安装依赖项 (使用清华镜像源静默安装)
python3 -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple --quiet

# 启动服务端
python3 server.py
