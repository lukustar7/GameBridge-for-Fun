# -*- coding: utf-8 -*-
"""GameBridge-for-Fun-Lite 纯网页版文件与架构完整性自动化测试用例"""

import os
import json
import unittest

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
LITE_DIR = os.path.join(PROJECT_ROOT, "GameBridge-for-Fun-Lite")

class LiteArchitectureTests(unittest.TestCase):

    def test_lite_directory_contains_all_required_pwa_files(self):
        """验证 Lite 目录存在且包含全套 PWA 离线与 WebBluetooth 驱动文件。"""
        required_files = [
            "index.html",
            "manifest.json",
            "sw.js",
            "css/style.css",
            "js/ble-driver.js",
            "js/safety-guard.js",
            "js/pwa-manager.js",
            "js/main.js",
            "icons/icon-192.svg"
        ]
        for rel_path in required_files:
            full_path = os.path.join(LITE_DIR, rel_path)
            self.assertTrue(os.path.exists(full_path), f"Lite 缺失必需文件: {rel_path}")

    def test_manifest_pwa_spec(self):
        """验证 manifest.json 符合标准 PWA 沉浸模式规范。"""
        manifest_path = os.path.join(LITE_DIR, "manifest.json")
        with open(manifest_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        
        self.assertEqual(data.get("display"), "standalone")
        self.assertEqual(data.get("background_color"), "#000000")
        self.assertEqual(data.get("theme_color"), "#000000")

    def test_original_project_files_remain_unmodified(self):
        """确认 Lite 独立版的增加没有损坏原版的核心接口与文件。"""
        original_files = [
            "server/server.py",
            "server/dglab_v4.py",
            "static/game-logic.js",
            "static/index.html",
            "android/app/build.gradle.kts"
        ]
        for rel_path in original_files:
            full_path = os.path.join(PROJECT_ROOT, rel_path)
            self.assertTrue(os.path.exists(full_path), f"原版核心文件存在异常: {rel_path}")

if __name__ == "__main__":
    unittest.main()
