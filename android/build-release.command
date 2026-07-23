#!/bin/bash
# 构建、签名、验签并刷新仓库中的公开 Beta APK。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VERSION="$(tr -d '\r\n' < "$PROJECT_ROOT/VERSION")"
SIGNING_DIR="${GAME_BRIDGE_FOR_FUN_SIGNING_DIR:-$HOME/Library/Application Support/GameBridge for Fun/signing}"
KEYSTORE_PATH="$SIGNING_DIR/gamebridge-for-fun-release.p12"
PASSWORD_PATH="$SIGNING_DIR/gamebridge-for-fun-release.password"
KEY_ALIAS="gamebridge-for-fun"

case "$VERSION" in
    ""|*[!0-9A-Za-z.-]*)
        echo "错误: VERSION 不是可用于安装包文件名的语义化版本。"
        exit 1
        ;;
esac

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

"$SCRIPT_DIR/create-release-key.command"
KEY_PASSWORD="$(<"$PASSWORD_PATH")"
export GAME_BRIDGE_FOR_FUN_ANDROID_KEYSTORE="$KEYSTORE_PATH"
export GAME_BRIDGE_FOR_FUN_ANDROID_KEYSTORE_PASSWORD="$KEY_PASSWORD"
export GAME_BRIDGE_FOR_FUN_ANDROID_KEY_ALIAS="$KEY_ALIAS"
export GAME_BRIDGE_FOR_FUN_ANDROID_KEY_PASSWORD="$KEY_PASSWORD"

cd "$SCRIPT_DIR"
./gradlew --no-daemon testDebugUnitTest lintDebug assembleRelease

SOURCE_APK="$SCRIPT_DIR/app/build/outputs/apk/release/app-release.apk"
OUTPUT_DIR="$PROJECT_ROOT/APK"
OUTPUT_NAME="GameBridgeForFun-Android15-v${VERSION}.apk"
APKSIGNER="$ANDROID_HOME/build-tools/36.1.0/apksigner"

if [ ! -x "$APKSIGNER" ]; then
    echo "错误: 未找到 Android Build Tools 36.1.0 的 apksigner。"
    exit 1
fi

SIGNATURE_REPORT="$("$APKSIGNER" verify --verbose --print-certs "$SOURCE_APK")"
printf '%s\n' "$SIGNATURE_REPORT"
if printf '%s\n' "$SIGNATURE_REPORT" | grep -q "CN=Android Debug"; then
    echo "错误: 正式包错误地使用了 Android 调试签名。"
    exit 1
fi
ACTUAL_SIGNER="$(printf '%s\n' "$SIGNATURE_REPORT" | sed -n 's/^Signer #1 certificate SHA-256 digest: //p' | tr '[:upper:]' '[:lower:]')"
EXPECTED_SIGNER="$(tr -d '[:space:]' < "$OUTPUT_DIR/SIGNER_SHA256.txt")"
if [ -z "$ACTUAL_SIGNER" ] || [ "$ACTUAL_SIGNER" != "$EXPECTED_SIGNER" ]; then
    echo "错误: 正式包签名与 APK/SIGNER_SHA256.txt 记录的发布身份不一致。"
    exit 1
fi

mkdir -p "$OUTPUT_DIR"
cp "$SOURCE_APK" "$OUTPUT_DIR/$OUTPUT_NAME"
(
    cd "$OUTPUT_DIR"
    shasum -a 256 "$OUTPUT_NAME" > SHA256.txt
    shasum -a 256 -c SHA256.txt
)

if ! cmp -s "$SOURCE_APK" "$OUTPUT_DIR/$OUTPUT_NAME"; then
    echo "错误: APK 交付包与 Gradle 编译产物不一致。"
    exit 1
fi

echo "正式 Beta 构建完成: $OUTPUT_DIR/$OUTPUT_NAME"
