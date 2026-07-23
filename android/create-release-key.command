#!/bin/bash
# 首次公开构建时创建稳定签名；密钥和随机口令只保存在当前 macOS 用户的应用数据目录。
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SIGNING_DIR="${GAME_BRIDGE_FOR_FUN_SIGNING_DIR:-$HOME/Library/Application Support/GameBridge for Fun/signing}"
KEYSTORE_PATH="$SIGNING_DIR/gamebridge-for-fun-release.p12"
PASSWORD_PATH="$SIGNING_DIR/gamebridge-for-fun-release.password"
KEY_ALIAS="gamebridge-for-fun"

if [ -z "${JAVA_HOME:-}" ]; then
    STUDIO_JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
    if [ ! -x "$STUDIO_JAVA_HOME/bin/keytool" ]; then
        echo "错误: 未找到 Android Studio 自带的 keytool，请先安装 Android Studio。"
        exit 1
    fi
    export JAVA_HOME="$STUDIO_JAVA_HOME"
fi

KEYTOOL="$JAVA_HOME/bin/keytool"
if [ ! -x "$KEYTOOL" ]; then
    echo "错误: 当前 JAVA_HOME 中没有可执行的 keytool。"
    exit 1
fi

mkdir -p "$SIGNING_DIR"
chmod 700 "$SIGNING_DIR"

if [ -f "$KEYSTORE_PATH" ] && [ -f "$PASSWORD_PATH" ]; then
    echo "正式签名已存在: $KEYSTORE_PATH"
    exit 0
fi

if [ -e "$KEYSTORE_PATH" ] || [ -e "$PASSWORD_PATH" ]; then
    echo "错误: 签名文件不完整。请先备份并人工检查 $SIGNING_DIR，程序不会擅自覆盖。"
    exit 1
fi

# 随机口令与密钥放在仅当前用户可读的目录；脚本从不把口令打印到终端。
/usr/bin/openssl rand -base64 48 | tr -d '\r\n' > "$PASSWORD_PATH"
chmod 600 "$PASSWORD_PATH"
KEY_PASSWORD="$(<"$PASSWORD_PATH")"

"$KEYTOOL" -genkeypair \
    -keystore "$KEYSTORE_PATH" \
    -storetype PKCS12 \
    -storepass "$KEY_PASSWORD" \
    -keypass "$KEY_PASSWORD" \
    -alias "$KEY_ALIAS" \
    -keyalg RSA \
    -keysize 4096 \
    -sigalg SHA256withRSA \
    -validity 9125 \
    -dname "CN=GameBridge for Fun, OU=Release, O=GameBridge for Fun, C=CN"

chmod 600 "$KEYSTORE_PATH"
echo "正式签名已创建: $KEYSTORE_PATH"
echo "必须备份整个签名目录；文件丢失后，旧用户将无法直接覆盖安装新版 APK。"
