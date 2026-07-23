#!/bin/bash
# 只读核对仓库内的公开 APK，不需要持有正式签名私钥。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VERSION="$(tr -d '\r\n' < "$PROJECT_ROOT/VERSION")"
APK_PATH="$PROJECT_ROOT/APK/GameBridgeForFun-Android15-v${VERSION}.apk"

if [ -z "${JAVA_HOME:-}" ]; then
    STUDIO_JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
    if [ ! -x "$STUDIO_JAVA_HOME/bin/java" ]; then
        echo "错误: 未找到 Android Studio 自带的 Java，无法核对公开 APK。"
        exit 1
    fi
    export JAVA_HOME="$STUDIO_JAVA_HOME"
fi

if [ -z "${ANDROID_HOME:-}" ]; then
    export ANDROID_HOME="$HOME/Library/Android/sdk"
fi
APKSIGNER="$ANDROID_HOME/build-tools/36.1.0/apksigner"
AAPT2="$ANDROID_HOME/build-tools/36.1.0/aapt2"

if [ ! -f "$APK_PATH" ]; then
    echo "错误: 缺少公开 APK：$APK_PATH"
    exit 1
fi
if [ ! -x "$APKSIGNER" ] || [ ! -x "$AAPT2" ]; then
    echo "错误: Android Build Tools 36.1.0 不完整，无法核对公开 APK。"
    exit 1
fi

(
    cd "$PROJECT_ROOT/APK"
    shasum -a 256 -c SHA256.txt
)

SIGNATURE_REPORT="$("$APKSIGNER" verify --verbose --print-certs "$APK_PATH")"
printf '%s\n' "$SIGNATURE_REPORT"
if printf '%s\n' "$SIGNATURE_REPORT" | grep -q "CN=Android Debug"; then
    echo "错误: 公开 APK 使用了 Android 调试签名。"
    exit 1
fi
ACTUAL_SIGNER="$(printf '%s\n' "$SIGNATURE_REPORT" | sed -n 's/^Signer #1 certificate SHA-256 digest: //p' | tr '[:upper:]' '[:lower:]')"
EXPECTED_SIGNER="$(tr -d '[:space:]' < "$PROJECT_ROOT/APK/SIGNER_SHA256.txt")"
if [ -z "$ACTUAL_SIGNER" ] || [ "$ACTUAL_SIGNER" != "$EXPECTED_SIGNER" ]; then
    echo "错误: 公开 APK 的签名身份与 APK/SIGNER_SHA256.txt 不一致。"
    exit 1
fi

BADGING_REPORT="$("$AAPT2" dump badging "$APK_PATH")"
if ! printf '%s\n' "$BADGING_REPORT" | grep -Fq "versionName='$VERSION'"; then
    echo "错误: APK 内部版本与 VERSION 不一致。"
    exit 1
fi

echo "公开 APK 的版本、校验值和正式签名均有效。"
