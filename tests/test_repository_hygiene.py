# -*- coding: utf-8 -*-
"""团队仓库忽略规则与交付文件边界测试。"""

import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def run_git(*arguments):
    """在项目根目录执行只读 Git 检查，返回完整结果供断言解释失败原因。"""

    return subprocess.run(
        ["git", *arguments],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )


class RepositoryHygieneTests(unittest.TestCase):
    """防止本机秘密或构建垃圾进入协作仓库，同时保留约定的 APK。"""

    def test_sensitive_and_generated_paths_are_ignored(self):
        """常见密钥、缓存、IDE 和 Android 本地产物必须在首次出现时就被忽略。"""

        ignored_paths = (
            "certs/private/local-root-key.pem",
            ".env",
            ".venv/bin/python",
            "__pycache__/server.cpython-313.pyc",
            ".idea/workspace.xml",
            "debug.log",
            "android/.gradle/cache/state.bin",
            "android/.kotlin/sessions/session.bin",
            "android/app/build/outputs/apk/debug/app-debug.apk",
            "android/local.properties",
            "android/debug.keystore",
            "android/signing/release.p12",
            "android/signing/release.password",
        )

        for relative_path in ignored_paths:
            with self.subTest(path=relative_path):
                result = run_git(
                    "check-ignore",
                    "--quiet",
                    "--no-index",
                    "--",
                    relative_path,
                )
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_team_apk_remains_tracked_and_not_ignored(self):
        """公开测试 APK 是明确交付物，不能被通用构建规则误伤。"""

        version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
        apk_path = f"APK/GameBridgeForFun-Android15-v{version}.apk"
        ignored = run_git("check-ignore", "--quiet", "--no-index", "--", apk_path)
        tracked = run_git("ls-files", "--error-unmatch", "--", apk_path)

        self.assertEqual(ignored.returncode, 1, ignored.stderr)
        self.assertEqual(tracked.returncode, 0, tracked.stderr)
        self.assertTrue((ROOT / apk_path).is_file())

    def test_current_tracked_files_do_not_match_ignore_rules(self):
        """新增规则不能把已跟踪源码悄悄变成未来无法更新的文件。"""

        result = run_git("ls-files", "-ci", "--exclude-standard")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "")


if __name__ == "__main__":
    unittest.main()
