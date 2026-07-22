# -*- coding: utf-8 -*-
"""macOS 启动前检查的依赖、文件和交付包边界测试。"""

import hashlib
import importlib.metadata
import sys
import tempfile
import unittest
from pathlib import Path

# 后端源码位于 server/ 子目录，测试导入前需要加入模块搜索路径。
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

import macos_preflight


class MacOSPreflightTests(unittest.TestCase):
    """验证启动器能在真正拉起服务前给出稳定、可理解的判断。"""

    def test_pinned_requirements_are_normalized(self):
        """包名的横线、下划线和点应视为等价，同时保留准确锁定版本。"""
        with tempfile.TemporaryDirectory() as directory:
            requirements_path = Path(directory) / "requirements.txt"
            requirements_path.write_text("Demo_Package.Name==1.2.3\n", encoding="utf-8")

            requirements = macos_preflight.read_pinned_requirements(requirements_path)

        self.assertEqual(
            requirements,
            {"demo-package-name": ("Demo_Package.Name", "1.2.3")},
        )

    def test_floating_requirement_is_rejected(self):
        """未固定版本的依赖会让不同电脑结果漂移，启动检查必须明确拒绝。"""
        with tempfile.TemporaryDirectory() as directory:
            requirements_path = Path(directory) / "requirements.txt"
            requirements_path.write_text("websockets>=12\n", encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "固定格式"):
                macos_preflight.read_pinned_requirements(requirements_path)

    def test_dependency_check_reports_missing_and_wrong_versions(self):
        """缺包与版本不匹配必须分别提示，不能把两者统称为启动失败。"""
        with tempfile.TemporaryDirectory() as directory:
            requirements_path = Path(directory) / "requirements.txt"
            requirements_path.write_text(
                "present==2.0\nmissing==1.0\n",
                encoding="utf-8",
            )

            def fake_version(package_name):
                if package_name == "missing":
                    raise importlib.metadata.PackageNotFoundError(package_name)
                return "1.5"

            problems = macos_preflight.dependency_problems(
                requirements_path,
                version_reader=fake_version,
            )

        self.assertEqual(
            problems,
            ["present 版本为 1.5，需要 2.0", "缺少 missing 1.0"],
        )

    def test_required_file_check_lists_each_missing_file(self):
        """不完整项目文件夹应列出缺项，避免进入服务后才抛出导入错误。"""
        with tempfile.TemporaryDirectory() as directory:
            problems = macos_preflight.required_file_problems(Path(directory))

        self.assertEqual(len(problems), len(macos_preflight.REQUIRED_RUNTIME_FILES))
        self.assertIn("缺少运行文件：server/server.py", problems)
        self.assertIn("缺少运行文件：server/coyote_waveforms.py", problems)

    def test_python_version_boundary(self):
        """Python 3.9 是最低支持线，3.8 必须给出升级提示。"""
        self.assertEqual(macos_preflight.python_version_problem((3, 9, 0)), "")
        self.assertIn("需要 Python 3.9", macos_preflight.python_version_problem((3, 8, 18)))

    def test_apk_checksum_accepts_matching_artifact(self):
        """安装包与校验值相同时不产生误报。"""
        with tempfile.TemporaryDirectory() as directory:
            project_root = Path(directory)
            apk_path = project_root / macos_preflight.APK_RELATIVE_PATH
            checksum_path = project_root / macos_preflight.APK_CHECKSUM_RELATIVE_PATH
            apk_path.parent.mkdir(parents=True)
            apk_bytes = b"verified-apk"
            apk_path.write_bytes(apk_bytes)
            checksum_path.write_text(
                f"{hashlib.sha256(apk_bytes).hexdigest()}  {apk_path.name}\n",
                encoding="utf-8",
            )

            warning = macos_preflight.apk_integrity_warning(project_root)

        self.assertEqual(warning, "")

    def test_apk_checksum_rejects_tampered_artifact(self):
        """APK 被替换或复制损坏时必须在启动阶段提醒用户。"""
        with tempfile.TemporaryDirectory() as directory:
            project_root = Path(directory)
            apk_path = project_root / macos_preflight.APK_RELATIVE_PATH
            checksum_path = project_root / macos_preflight.APK_CHECKSUM_RELATIVE_PATH
            apk_path.parent.mkdir(parents=True)
            apk_path.write_bytes(b"tampered-apk")
            checksum_path.write_text(f"{'0' * 64}  {apk_path.name}\n", encoding="utf-8")

            warning = macos_preflight.apk_integrity_warning(project_root)

        self.assertIn("不一致", warning)


if __name__ == "__main__":
    unittest.main()
