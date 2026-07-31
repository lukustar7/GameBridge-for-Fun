#!/bin/zsh
set -euo pipefail

# Lite 的检查完全局限在自己的目录，不启动真实蓝牙连接。
SCRIPT_DIR="${0:A:h}"
cd "$SCRIPT_DIR"

node --check js/coyote-protocol.js
node --check js/waveforms.js
node --check js/ble-driver.js
node --check js/output-controller.js
node --check js/game-logic.js
node --check js/game-config.js
node --check js/pwa-manager.js
node --check js/main.js
node --check sw.js
node tests/test-lite.js

echo "Lite 本地检查通过"
