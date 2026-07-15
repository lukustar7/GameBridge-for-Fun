#!/bin/bash
# GameBridge for Fun Android 调试包一键构建脚本。
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

# 把 Gradle 深层目录里的产物复制到项目根目录，非技术用户无需再逐层寻找 build 文件夹。
OUTPUT_DIR="$SCRIPT_DIR/../APK"
OUTPUT_NAME="GameBridgeForFun-Android15-debug.apk"
SOURCE_APK="$SCRIPT_DIR/app/build/outputs/apk/debug/app-debug.apk"
mkdir -p "$OUTPUT_DIR"
cp "$SOURCE_APK" "$OUTPUT_DIR/$OUTPUT_NAME"
(
    cd "$OUTPUT_DIR"
    shasum -a 256 "$OUTPUT_NAME" > SHA256.txt
    shasum -a 256 -c SHA256.txt
)

# 交付目录必须与刚刚编译出的文件逐字节一致，防止只通过 Gradle 编译却遗漏复制步骤。
if ! cmp -s "$SOURCE_APK" "$OUTPUT_DIR/$OUTPUT_NAME"; then
    echo "错误: APK 交付包与 Gradle 编译产物不一致。"
    exit 1
fi

# 调试包也必须带有可安装签名；未签名或复制损坏时不允许生成“构建完成”提示。
APKSIGNER="$ANDROID_HOME/build-tools/36.1.0/apksigner"
if [ ! -x "$APKSIGNER" ]; then
    echo "错误: 未找到 Android Build Tools 36.1.0 的 apksigner。"
    exit 1
fi
"$APKSIGNER" verify --verbose --print-certs "$OUTPUT_DIR/$OUTPUT_NAME"

echo "构建完成: $OUTPUT_DIR/$OUTPUT_NAME"
