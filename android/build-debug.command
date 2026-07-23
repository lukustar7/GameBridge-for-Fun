#!/bin/bash
# GameBridge for Fun Android 调试构建脚本；正式交付包由 build-release.command 生成。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# macOS 没有全局 Java 时，直接复用 Android Studio 自带且经过匹配测试的 JBR。
if [ -z "${JAVA_HOME:-}" ]; then
    STUDIO_JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
    if [ ! -x "$STUDIO_JAVA_HOME/bin/java" ]; then
        echo "错误: 未找到 Android Studio 自带的 Java，请先安装 Android Studio。"
        exit 1
    fi
    export JAVA_HOME="$STUDIO_JAVA_HOME"
fi

if [ -z "${ANDROID_HOME:-}" ]; then
    export ANDROID_HOME="$HOME/Library/Android/sdk"
fi
if [ ! -d "$ANDROID_HOME" ]; then
    echo "错误: 未找到 Android SDK，请先在 Android Studio 中完成 SDK 安装。"
    exit 1
fi

cd "$SCRIPT_DIR"
./gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug

SOURCE_APK="$SCRIPT_DIR/app/build/outputs/apk/debug/app-debug.apk"

# 调试包也必须带有可安装签名；它只用于开发验证，不能覆盖公开发布包。
APKSIGNER="$ANDROID_HOME/build-tools/36.1.0/apksigner"
if [ ! -x "$APKSIGNER" ]; then
    echo "错误: 未找到 Android Build Tools 36.1.0 的 apksigner。"
    exit 1
fi
"$APKSIGNER" verify --verbose --print-certs "$SOURCE_APK"

echo "调试构建通过: $SOURCE_APK"
