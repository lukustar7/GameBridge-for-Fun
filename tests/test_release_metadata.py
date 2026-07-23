# -*- coding: utf-8 -*-
"""公开版本、文档、安装包命名与第三方声明的一致性检查。"""

import hashlib
import re
import stat
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class ReleaseMetadataTests(unittest.TestCase):
    """防止同一次发版在 Python、Android、文档和 APK 中出现不同版本。"""

    @classmethod
    def setUpClass(cls):
        cls.version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()

    def test_public_version_is_semver_beta(self):
        """首次公开版本必须是可排序的标准 Beta 语义化版本。"""
        self.assertRegex(self.version, r"^\d+\.\d+\.\d+-beta\.\d+$")

    def test_python_android_lock_and_changelog_share_version(self):
        """四份发布元数据必须引用同一个根版本，避免安装包和说明互相冲突。"""
        pyproject = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
        uv_lock = (ROOT / "uv.lock").read_text(encoding="utf-8")
        android_build = (ROOT / "android/app/build.gradle.kts").read_text(encoding="utf-8")
        changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")

        self.assertIn(f'version = "{self.version}"', pyproject)
        self.assertIn(f'version = "{self.version}"', uv_lock)
        self.assertIn('versionName = publicVersion', android_build)
        self.assertIn('versionCode = 2', android_build)
        self.assertIn(f"## [{self.version}] - 2026-07-23", changelog)

    def test_public_readme_has_required_beta_and_non_gambling_notices(self):
        """公开首页必须保留用户确认过的 Beta 原文和无金钱玩法边界。"""
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        beta_notice = (
            "本项目处于早期 Beta 阶段，仅部分功能完成实机验证。"
            "由于实机测试会消耗测试人员，暂未覆盖全部设备、玩法和极端情况。"
            "请从低强度开始，避免将软件自动保护作为唯一安全措施。"
        )

        self.assertIn(beta_notice, readme)
        self.assertIn("严禁用于赌博、押注、收费抽奖、代币兑换", readme)
        self.assertNotIn("郊狼", readme)
        self.assertNotRegex(readme, r"!\[[^\]]*\]\(")

    def test_license_notices_and_editable_source_are_present(self):
        """源码公开必须同时交付修改入口、非商业许可和第三方来源。"""
        required_paths = (
            "LICENSE.md",
            "THIRD_PARTY_NOTICES.md",
            "CONTRIBUTING.md",
            "SECURITY.md",
            "server/server.py",
            "static/game.js",
            "android/app/build.gradle.kts",
            "tests/test_server.py",
        )
        for relative_path in required_paths:
            with self.subTest(path=relative_path):
                self.assertTrue((ROOT / relative_path).is_file())

        license_text = (ROOT / "LICENSE.md").read_text(encoding="utf-8")
        notices = (ROOT / "THIRD_PARTY_NOTICES.md").read_text(encoding="utf-8")
        self.assertIn("PolyForm Noncommercial License 1.0.0", license_text)
        self.assertIn("Required Notice: Copyright 2026 lukustar7", license_text)
        self.assertIn("qrcodejs 1.0.0", notices)
        self.assertIn("websockets 12.0", notices)

    def test_vendored_qrcode_matches_declared_upstream_release(self):
        """第三方压缩文件发生变化时必须重新核对来源与许可。"""
        digest = hashlib.sha256((ROOT / "static/qrcode.min.js").read_bytes()).hexdigest()
        self.assertEqual(
            digest,
            "c541ef06327885a8415bca8df6071e14189b4855336def4f36db54bde8484f36",
        )

    def test_release_signer_identity_is_pinned(self):
        """公开 APK 的长期升级身份必须固定，不能只判断它不是调试签名。"""
        signer = (ROOT / "APK/SIGNER_SHA256.txt").read_text(encoding="utf-8").strip()
        self.assertRegex(signer, r"^[0-9a-f]{64}$")
        self.assertEqual(
            signer,
            "23032cc4aac228f3e9d7b77929b9ed53dbf68a6e5a7eb4f8b3e787c223c2cd9e",
        )

    def test_release_scripts_are_executable_and_do_not_embed_passwords(self):
        """正式构建入口必须可双击，同时不能把签名口令写进源码。"""
        script_paths = (
            ROOT / "android/create-release-key.command",
            ROOT / "android/build-release.command",
            ROOT / "android/verify-packaged.command",
        )
        for script_path in script_paths:
            with self.subTest(path=script_path.name):
                mode = stat.S_IMODE(script_path.stat().st_mode)
                self.assertTrue(mode & stat.S_IXUSR)
                script = script_path.read_text(encoding="utf-8")
                self.assertNotRegex(script, re.compile(r"password\s*=\s*['\"][^$]", re.IGNORECASE))


if __name__ == "__main__":
    unittest.main()
