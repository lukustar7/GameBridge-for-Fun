# -*- coding: utf-8 -*-
"""macOS 双击启动前的本地环境、运行文件、网络与证书检查。"""

import argparse
import hashlib
import importlib.metadata
import os
import platform
import re
import ssl
import sys
import tempfile
from pathlib import Path


# 本文件与后端源码同在 server/ 子目录，检查目标仍是项目根目录。
PROJECT_ROOT = Path(__file__).resolve().parents[1]
MINIMUM_PYTHON = (3, 9)
TUNA_HOMEBREW_HELP = "https://mirrors.tuna.tsinghua.edu.cn/help/homebrew/"
TUNA_HOMEBREW_API = "https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles/api"
TUNA_HOMEBREW_BOTTLES = "https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles"
REQUIRED_RUNTIME_FILES = (
    "server/server.py",
    "server/dglab_v4.py",
    "server/coyote_waveforms.py",
    "requirements.txt",
    "static/index.html",
    "static/console.js",
    "static/game.html",
    "static/game.js",
    "static/game-logic.js",
    "static/style.css",
    "static/qrcode.min.js",
)
APK_RELATIVE_PATH = Path("APK/GameBridgeForFun-Android15-debug.apk")
APK_CHECKSUM_RELATIVE_PATH = Path("APK/SHA256.txt")
PINNED_REQUIREMENT_PATTERN = re.compile(
    r"^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s;]+)$"
)


def canonical_package_name(name):
    """统一包名中的横线、下划线和点，避免同一个包因写法不同被误判为缺失。"""
    return re.sub(r"[-_.]+", "-", name).lower()


def read_pinned_requirements(requirements_path):
    """读取完全锁定的 Python 依赖；不接受浮动版本，防止不同电脑安装出不同结果。"""
    requirements = {}
    for line_number, raw_line in enumerate(
        requirements_path.read_text(encoding="utf-8").splitlines(),
        start=1,
    ):
        line = raw_line.split("#", 1)[0].strip()
        if not line:
            continue

        match = PINNED_REQUIREMENT_PATTERN.fullmatch(line)
        if not match:
            raise ValueError(
                f"requirements.txt 第 {line_number} 行没有使用 包名==版本号 的固定格式"
            )
        package_name, expected_version = match.groups()
        requirements[canonical_package_name(package_name)] = (
            package_name,
            expected_version,
        )
    return requirements


def dependency_problems(requirements_path, version_reader=importlib.metadata.version):
    """返回缺失或版本不一致的依赖，让启动脚本只在确有需要时联网安装。"""
    try:
        requirements = read_pinned_requirements(requirements_path)
    except (OSError, UnicodeError, ValueError) as error:
        return [str(error)]

    problems = []
    for canonical_name, (display_name, expected_version) in requirements.items():
        try:
            installed_version = version_reader(canonical_name)
        except importlib.metadata.PackageNotFoundError:
            problems.append(f"缺少 {display_name} {expected_version}")
            continue

        if installed_version != expected_version:
            problems.append(
                f"{display_name} 版本为 {installed_version}，需要 {expected_version}"
            )
    return problems


def required_file_problems(project_root):
    """检查启动必需文件，防止用户拿到不完整文件夹后看到难懂的导入错误。"""
    return [
        f"缺少运行文件：{relative_path}"
        for relative_path in REQUIRED_RUNTIME_FILES
        if not (project_root / relative_path).is_file()
    ]


def python_version_problem(version_info=sys.version_info):
    """验证最低 Python 版本；项目仍兼容 macOS 自带开发工具常见的 Python 3.9。"""
    if tuple(version_info[:2]) >= MINIMUM_PYTHON:
        return ""
    current = ".".join(str(value) for value in version_info[:3])
    return f"Python 版本为 {current}，需要 Python 3.9 或更高版本"


def project_write_problem(project_root):
    """实际创建并删除一个临时文件，确认虚拟环境和证书确实能写入当前目录。"""
    try:
        descriptor, temporary_path = tempfile.mkstemp(
            prefix=".gamebridge-write-test-",
            dir=str(project_root),
        )
        os.close(descriptor)
        Path(temporary_path).unlink()
        return ""
    except OSError as error:
        return f"项目目录不可写：{error}"


def apk_integrity_warning(project_root):
    """核对随项目交付的 APK；异常只影响 Android 安装，不阻断网页玩法启动。"""
    apk_path = project_root / APK_RELATIVE_PATH
    checksum_path = project_root / APK_CHECKSUM_RELATIVE_PATH
    if not apk_path.is_file() or not checksum_path.is_file():
        return "Android APK 或 SHA-256 校验文件缺失，APK 安装入口可能不可用"

    try:
        expected_match = re.search(
            r"\b([0-9a-fA-F]{64})\b",
            checksum_path.read_text(encoding="utf-8"),
        )
        if expected_match is None:
            return "Android APK 校验文件格式错误，无法确认安装包完整性"

        # 分块读取避免未来安装包变大时一次占用与文件等量的内存。
        digest = hashlib.sha256()
        with apk_path.open("rb") as apk_file:
            for chunk in iter(lambda: apk_file.read(1024 * 1024), b""):
                digest.update(chunk)
        actual_hash = digest.hexdigest()
        if actual_hash.lower() != expected_match.group(1).lower():
            return "Android APK 与 SHA-256 校验值不一致，请重新取得完整项目文件"
    except (OSError, UnicodeError) as error:
        return f"无法检查 Android APK 完整性：{error}"
    return ""


def print_problems(problems):
    """逐条输出面向普通用户的错误，避免只给出一串 Python 调用栈。"""
    for problem in problems:
        print(f"[失败] {problem}")


def check_dependencies(project_root=PROJECT_ROOT):
    """单独检查虚拟环境中的锁定依赖，供 Shell 决定是否需要访问镜像。"""
    problems = dependency_problems(project_root / "requirements.txt")
    if problems:
        print_problems(problems)
        return 1
    print("[通过] Python 依赖版本与项目要求一致")
    return 0


def prepare_runtime(project_root=PROJECT_ROOT):
    """执行服务启动前的完整体检，并提前准备本机 HTTPS 证书。"""
    problems = []
    if platform.system() != "Darwin":
        problems.append("当前启动器只支持 macOS")

    version_problem = python_version_problem()
    if version_problem:
        problems.append(version_problem)
    problems.extend(required_file_problems(project_root))

    write_problem = project_write_problem(project_root)
    if write_problem:
        problems.append(write_problem)

    dependency_errors = dependency_problems(project_root / "requirements.txt")
    problems.extend(dependency_errors)
    if problems:
        print_problems(problems)
        return 1

    print(f"[通过] macOS 与 Python {platform.python_version()} 运行环境可用")
    print("[通过] 项目运行文件完整，当前目录可写")
    print("[通过] Python 依赖版本与项目要求一致")

    # 此时第三方依赖已经通过检查，可以安全导入后端并复用同一套网络、证书逻辑。
    try:
        import server
    except Exception as error:
        print(f"[失败] 后端模块无法载入：{error}")
        return 1

    openssl_path = server.find_openssl_executable()
    if not openssl_path:
        print("[失败] 未找到 macOS 的 OpenSSL，无法为手机 HTTPS 页面生成本地证书")
        print("        请先完成系统更新；如仍缺失，可用已安装的 Homebrew 和清华镜像执行：")
        print(
            "        env "
            f"HOMEBREW_API_DOMAIN={TUNA_HOMEBREW_API} "
            f"HOMEBREW_BOTTLE_DOMAIN={TUNA_HOMEBREW_BOTTLES} "
            "brew install openssl@3"
        )
        print(f"        清华 Homebrew 镜像说明：{TUNA_HOMEBREW_HELP}")
        return 1
    print(f"[通过] 证书工具可用：{openssl_path}")

    local_ip = server.get_local_ip()
    if not server.normalize_private_ipv4(local_ip):
        print("[失败] 没有检测到手机可访问的局域网地址")
        print("        请让 Mac 与手机连接同一个 Wi-Fi，关闭会接管网络的 VPN 后重试")
        print("        如自动识别错误，可设置 GAME_BRIDGE_FOR_FUN_CERT_IP 后再启动")
        return 1

    server.LOCAL_IP = local_ip
    server.CERTIFIED_LAN_IP = server.CERT_IP_OVERRIDE or local_ip
    print(f"[通过] 局域网地址可用：{local_ip}")

    if not server.ensure_local_https_assets():
        print("[失败] 本地 HTTPS 证书准备失败，请查看上一行的具体原因")
        return 1

    # 证书文件存在并不代表证书和私钥一定配对；让 TLS 引擎实际加载一次才能提前发现损坏。
    try:
        tls_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls_context.load_cert_chain(
            str(server.SERVER_CERT_PEM),
            str(server.SERVER_CERT_KEY),
        )
    except (OSError, ssl.SSLError) as error:
        print(f"[失败] HTTPS 证书或私钥无法使用：{error}")
        return 1
    print(f"[通过] HTTPS 证书已就绪，签发地址：{server.CERTIFIED_LAN_IP}")

    warning = apk_integrity_warning(project_root)
    if warning:
        print(f"[提醒] {warning}")
    else:
        print("[通过] Android APK 与 SHA-256 校验值一致")

    print("[完成] 启动前检查全部通过，正在启动服务")
    return 0


def main(argv=None):
    """提供两个稳定入口：依赖探测用于安装前，完整体检用于真正启动前。"""
    parser = argparse.ArgumentParser(description="GameBridge for Fun macOS 启动前检查")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check-dependencies", action="store_true")
    mode.add_argument("--prepare-runtime", action="store_true")
    arguments = parser.parse_args(argv)

    if arguments.check_dependencies:
        return check_dependencies()
    return prepare_runtime()


if __name__ == "__main__":
    raise SystemExit(main())
