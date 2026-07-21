# -*- coding: utf-8 -*-
"""GameBridge for Fun 后端核心服务。"""
import asyncio
import hashlib
import ipaddress
import json
import math
import os
import plistlib
import re
import secrets
import signal
import shutil
import socket
import ssl
import subprocess
import threading
import uuid
import webbrowser
from datetime import datetime, timedelta, timezone
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse
import websockets
from dglab_v4 import (
    Channel,
    DGLabV4Bridge,
    DeviceBridgeError,
)


def read_positive_int_env(name, default_value):
    """读取正整数环境变量；写错时使用默认值，避免证书策略配置错误导致服务无法启动"""
    try:
        value = int(os.environ.get(name, str(default_value)))
    except (TypeError, ValueError):
        return default_value
    return value if value > 0 else default_value


RFC1918_NETWORKS = tuple(
    ipaddress.ip_network(cidr)
    for cidr in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")
)


def normalize_private_ipv4(value):
    """把输入规范化为 Android 与局域网网页都能访问的 RFC1918 IPv4；非法值返回空字符串"""
    try:
        address = ipaddress.ip_address(str(value).strip())
    except ValueError:
        return ""

    if address.version != 4 or not any(address in network for network in RFC1918_NETWORKS):
        return ""
    return str(address)


# --- 全局状态与配置 ---
PROJECT_ROOT = Path(__file__).resolve().parent
STATIC_ROOT = PROJECT_ROOT / "static"
LOCAL_IP = "127.0.0.1"

# 默认端口定义 (五位数起步)
HTTP_PORT = 18080
WEB_WS_PORT = 18081
APP_WS_PORT = 15678
HTTPS_PORT = 18443
SECURE_WEB_WS_PORT = 18444
GAME_ACCESS_TOKEN = secrets.token_urlsafe(18)

# 手机传感器权限通常需要 HTTPS。默认按当前局域网 IP 自动签发服务器证书；
# 如现场网络必须固定某个地址，可通过品牌独立的环境变量覆盖自动检测结果。
RAW_CERT_IP_OVERRIDE = os.environ.get("GAME_BRIDGE_FOR_FUN_CERT_IP", "").strip()
CERT_IP_OVERRIDE = normalize_private_ipv4(RAW_CERT_IP_OVERRIDE)
CERTIFIED_LAN_IP = CERT_IP_OVERRIDE
ROOT_CA_VALID_DAYS = read_positive_int_env("GAME_BRIDGE_FOR_FUN_ROOT_CA_DAYS", 90)
SERVER_CERT_VALID_DAYS = read_positive_int_env("GAME_BRIDGE_FOR_FUN_SERVER_CERT_DAYS", 7)
CERT_DIR = PROJECT_ROOT / "certs"
CERT_PRIVATE_DIR = CERT_DIR / "private"
ROOT_CA_PEM = CERT_DIR / "gamebridge-for-fun-root-ca.pem"
ROOT_CA_CER = CERT_DIR / "gamebridge-for-fun-root-ca.cer"
ROOT_CA_MOBILECONFIG = CERT_DIR / "gamebridge-for-fun-root-ca.mobileconfig"
ROOT_CA_KEY = CERT_PRIVATE_DIR / "gamebridge-for-fun-root-ca-key.pem"
SERVER_CERT_PEM = CERT_DIR / "gamebridge-for-fun-server.pem"
SERVER_CERT_KEY = CERT_PRIVATE_DIR / "gamebridge-for-fun-server-key.pem"
SERVER_CERT_CSR = CERT_PRIVATE_DIR / "gamebridge-for-fun-server.csr"
SERVER_CERT_CONFIG = CERT_PRIVATE_DIR / "gamebridge-for-fun-server-openssl.cnf"
CERT_IP_MARKER = CERT_DIR / "gamebridge-for-fun-cert-ip.txt"
CERT_POLICY_MARKER = CERT_DIR / "gamebridge-for-fun-cert-policy.json"
ROOT_CA_CER_URL_PATH = "/certs/gamebridge-for-fun-root-ca.cer"
ROOT_CA_MOBILECONFIG_URL_PATH = "/certs/gamebridge-for-fun-root-ca.mobileconfig"
CERT_SHA256 = ""
CERT_ROOT_NOT_AFTER = ""
CERT_SERVER_NOT_AFTER = ""
HTTPS_ENABLED = False

# 游戏端惩罚的硬边界。前端也会限流，但后端必须自己兜底，不能相信局域网客户端。
MIN_SHOCK_DURATION_MS = 100
MAX_SHOCK_DURATION_MS = 60000
MIN_PULSE_INTERVAL_SECONDS = 0.22
MAX_WEB_MESSAGE_BYTES = 4096
MAX_WEB_MESSAGE_QUEUE = 8
MAX_APP_MESSAGE_BYTES = 65536
TEST_MAX_STRENGTH = 30
TEST_MAX_DURATION_MS = 1000
TEST_COOLDOWN_SECONDS = 1.5
HARDWARE_COMMAND_TIMEOUT_SECONDS = 1.0
# V4 非零强度必须带自动到期时间。额外余量覆盖最后一帧、网络抖动和停止指令往返，
# 即使电脑进程意外退出，App 端也会在有限时间内自行把临时强度恢复为 0。
OUTPUT_AUTO_RESET_MARGIN_MS = 800
# 游戏页每秒会发送应用层心跳。输出期间连续超过该时间没有收到所属页面的任何消息，
# 说明页面可能冻结、网络半断开或系统已经暂停 JavaScript；后端必须自行停机，不能只等 WebSocket 断开。
OUTPUT_HEARTBEAT_TIMEOUT_SECONDS = 3.5
# 持续型玩法的前端最短约 300ms 才会续发一次；超过该时间仍无新脉冲，说明玩家已回到安全区
# 或传感器判定已停止。普通网络 ping 不能替它续期，否则通道强度会长期停留在非零值。
CONTINUOUS_OUTPUT_IDLE_TIMEOUT_SECONDS = 0.75
DISABLE_AUTO_BROWSER = os.environ.get("GAME_BRIDGE_FOR_FUN_NO_BROWSER", "").strip() == "1"

# 服务运行实例句柄 (用于端口热重启)
http_server_instance = None
https_server_instance = None
web_ws_server_instance = None
secure_web_ws_server_instance = None
http_server_ready = threading.Event()
https_server_ready = threading.Event()

# app_client 缓存
device_app_client = None

# 系统连接状态
state = {
    "app_connected": False,      # 手机设备 App 是否已绑定
    "device_connected": False,   # 已选择的郊狼硬件是否通过蓝牙就绪
    "app_latency": -1,           # 电脑到手机 App 的网速延迟 (ms)
    "game_latency": -1,          # 电脑到手机浏览器小游戏页的应用层延迟 (ms)
    "app_qrcode_url": "",        # 手机 App 绑定扫码 URL
    "client_strength_a": 0,      # A 通道当前实际强度
    "client_strength_b": 0,      # B 通道当前实际强度
    # None 表示 App 还没有回传限幅。未知限幅不能按 200 处理，否则刚绑定时可能越过用户在 App 内设定的安全上限。
    "limit_a": None,             # A 通道硬件上限限制
    "limit_b": None,             # B 通道硬件上限限制
    "battery_level": None,       # V4 props.power 回传的设备电量
    "game_client_connected": False, # 手机小游戏网页是否已连入
    "bridge_protocol": "V4",    # DG-LAB 4 App 使用的桥接协议
    "device_type": None,         # COYOTE_020 / COYOTE_030
    "device_model": None,        # 面向用户显示的硬件型号
    "device_name": None,         # App 内设备名称
    "device_status_message": "等待 DG-LAB 4 App 扫码",
    "selected_device_id": None,
    "selection_required": False,
    "compatible_devices": [],
    "muted_a": False,
    "muted_b": False,
    "overheat_a": False,
    "overheat_b": False,
    "channel_status_a": None,
    "channel_status_b": None,
}

# 维护当前连接的控制台和游戏端连接
console_connections = set()
game_connections = set()

# 锁机制，防止异步状态冲突
state_lock = asyncio.Lock()
shock_lock = asyncio.Lock()

# 记录每个游戏 WebSocket 最近一次惩罚请求时间，用于抑制疯狂点击或恶意刷包。
game_connection_last_pulse_at = {}
shock_generation = 0
last_test_shock_at = 0
active_output_task = None
active_output_clear_after = True
output_watchdog_task = None
output_watchdog_owner = None
output_watchdog_mode = None
output_watchdog_generation = 0


# --- 工具函数：网络与端口探测 ---

def get_local_ip():
    """获取手机能访问的本地局域网 IPv4 地址，避开 VPN/虚拟网卡地址"""

    candidates = []

    # macOS 的默认路由代表当前真正承担局域网通信的网卡。先读取该网卡地址，
    # 能避免 VPN、Docker 或虚拟机网卡排在 Wi-Fi 前面时生成无法扫码访问的地址。
    try:
        route_result = subprocess.run(
            ["/sbin/route", "-n", "get", "default"],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=2,
        )
        interface_match = re.search(
            r"^\s*interface:\s*([A-Za-z0-9._-]+)\s*$",
            route_result.stdout,
            re.MULTILINE,
        )
        interface_name = interface_match.group(1) if interface_match else ""
        # macOS 的 Wi-Fi、内置网卡和 USB 网卡通常使用 en0、en1 等名称；
        # utun、bridge、awdl 等虚拟接口即使成为默认路由，也不能优先写进手机二维码。
        if route_result.returncode == 0 and re.fullmatch(r"en\d+", interface_name):
            address_result = subprocess.run(
                ["/usr/sbin/ipconfig", "getifaddr", interface_name],
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
                timeout=2,
            )
            if address_result.returncode == 0:
                normalized = normalize_private_ipv4(address_result.stdout)
                if normalized:
                    candidates.append(normalized)
    except Exception:
        pass

    # 默认路由读取失败时，再从全部网卡中收集地址。物理 en 网卡优先，
    # 明确的虚拟接口完全忽略，减少 VPN 或虚拟机地址被放进二维码的概率。
    try:
        output = subprocess.check_output(["/sbin/ifconfig"], text=True, timeout=2)
        physical_candidates = []
        fallback_candidates = []
        current_interface = ""
        ignored_prefixes = (
            "lo",
            "utun",
            "bridge",
            "awdl",
            "llw",
            "gif",
            "stf",
            "vmenet",
        )
        for line in output.splitlines():
            interface_header = re.match(r"^([A-Za-z0-9._-]+):", line)
            if interface_header:
                current_interface = interface_header.group(1)
                continue

            address_match = re.search(r"\binet (\d+\.\d+\.\d+\.\d+)\b", line)
            normalized = (
                normalize_private_ipv4(address_match.group(1))
                if address_match
                else ""
            )
            if not normalized or current_interface.startswith(ignored_prefixes):
                continue
            if re.fullmatch(r"en\d+", current_interface):
                physical_candidates.append(normalized)
            else:
                fallback_candidates.append(normalized)
        candidates.extend(physical_candidates)
        candidates.extend(fallback_candidates)
    except Exception:
        pass

    # 兜底：再尝试系统主机名解析，避免非 macOS 环境没有 ifconfig。
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip_text = info[4][0]
            normalized = normalize_private_ipv4(ip_text)
            if normalized:
                candidates.append(normalized)
    except Exception:
        pass

    if candidates:
        # 保持顺序去重，避免重复网卡地址导致日志混乱。
        unique_candidates = list(dict.fromkeys(candidates))
        if CERT_IP_OVERRIDE in unique_candidates:
            return CERT_IP_OVERRIDE
        return unique_candidates[0]

    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # 最后兜底：连接一个虚拟外部地址，不产生实际流量，但可能被 VPN 劫持。
        s.connect(("8.8.8.8", 80))
        ip = normalize_private_ipv4(s.getsockname()[0]) or "127.0.0.1"
    except Exception:
        ip = "127.0.0.1"
    finally:
        s.close()
    return ip


def find_openssl_executable():
    """查找 macOS 系统或 Homebrew 提供的 OpenSSL，并兼容 Apple Silicon 与 Intel 路径。"""
    candidates = (
        "/usr/bin/openssl",
        "/opt/homebrew/opt/openssl@3/bin/openssl",
        "/usr/local/opt/openssl@3/bin/openssl",
        shutil.which("openssl"),
    )
    for candidate in dict.fromkeys(candidate for candidate in candidates if candidate):
        if Path(candidate).is_file() and os.access(candidate, os.X_OK):
            return candidate
    return ""


def find_free_port(start_port):
    """从起始值向上寻找空闲端口；到达 65535 后明确失败，避免无限循环"""
    try:
        normalized_start = int(start_port)
    except (TypeError, ValueError, OverflowError) as error:
        raise ValueError("端口起始值必须是 1-65535 的整数") from error
    if normalized_start not in range(1, 65536):
        raise ValueError("端口起始值必须位于 1-65535")

    for port in range(normalized_start, 65536):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("0.0.0.0", port))
                return port
            except OSError:
                continue
    raise OSError(f"从 {normalized_start} 到 65535 没有可用端口")


def run_openssl(args):
    """执行本地 openssl 命令；失败时抛出带原因的异常，方便启动日志定位"""
    openssl_executable = find_openssl_executable()
    if not openssl_executable:
        raise RuntimeError("未找到可执行的 OpenSSL")
    result = subprocess.run(
        [openssl_executable, *args],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "unknown openssl error").strip()
        raise RuntimeError(detail)


def read_certificate_not_after(cert_path):
    """读取证书到期时间；读不到时返回 None，让调用方按“需要重建”处理"""
    if not cert_path.exists():
        return None

    openssl_executable = find_openssl_executable()
    if not openssl_executable:
        return None

    result = subprocess.run(
        [
            openssl_executable,
            "x509",
            "-in",
            str(cert_path),
            "-noout",
            "-enddate",
        ],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False
    )
    if result.returncode != 0:
        return None

    raw_value = result.stdout.strip().split("=", 1)[-1].strip()
    try:
        parsed = datetime.strptime(raw_value, "%b %d %H:%M:%S %Y %Z")
    except ValueError:
        return None
    return parsed.replace(tzinfo=timezone.utc)


def certificate_expires_within(cert_path, days):
    """判断证书是否已经过期，或将在指定天数内过期"""
    not_after = read_certificate_not_after(cert_path)
    if not_after is None:
        return True
    return not_after <= datetime.now(timezone.utc) + timedelta(days=days)


def certificate_remaining_days(cert_path):
    """返回证书剩余天数；证书损坏或不存在时返回 -1"""
    not_after = read_certificate_not_after(cert_path)
    if not_after is None:
        return -1
    remaining = not_after - datetime.now(timezone.utc)
    return max(-1, remaining.days)


def format_cert_time(cert_path):
    """把证书到期时间转成前端可解析的 ISO 文本"""
    not_after = read_certificate_not_after(cert_path)
    return not_after.isoformat() if not_after else ""


def write_server_cert_config():
    """写入服务端证书 SAN 配置，保证证书明确绑定当前局域网 IP"""
    SERVER_CERT_CONFIG.write_text(
        "\n".join([
            "[req]",
            "default_bits = 2048",
            "prompt = no",
            "default_md = sha256",
            "distinguished_name = dn",
            "req_extensions = req_ext",
            "",
            "[dn]",
            f"CN = {CERTIFIED_LAN_IP}",
            "",
            "[req_ext]",
            "subjectAltName = @alt_names",
            "",
            "[alt_names]",
            f"IP.1 = {CERTIFIED_LAN_IP}",
            "IP.2 = 127.0.0.1",
            "DNS.1 = localhost",
            ""
        ]),
        encoding="utf-8"
    )


def build_mobileconfig(root_der):
    """生成 iPhone 可直接安装的根证书描述文件"""
    profile = {
        "PayloadContent": [
            {
                "PayloadCertificateFileName": "gamebridge-for-fun-root-ca.cer",
                "PayloadContent": root_der,
                "PayloadDescription": "GameBridge for Fun 本地 HTTPS 根证书，仅用于信任本机局域网小游戏服务。",
                "PayloadDisplayName": "GameBridge for Fun Local Root CA",
                "PayloadIdentifier": "local.gamebridgeforfun.root-ca",
                "PayloadType": "com.apple.security.root",
                "PayloadUUID": str(uuid.uuid4()).upper(),
                "PayloadVersion": 1
            }
        ],
        "PayloadDescription": "安装后需在 设置 > 通用 > 关于本机 > 证书信任设置 中手动开启完全信任。",
        "PayloadDisplayName": "GameBridge for Fun 本地 HTTPS 根证书",
        "PayloadIdentifier": "local.gamebridgeforfun.profile",
        "PayloadOrganization": "GameBridge for Fun",
        "PayloadRemovalDisallowed": False,
        "PayloadType": "Configuration",
        "PayloadUUID": str(uuid.uuid4()).upper(),
        "PayloadVersion": 1
    }
    ROOT_CA_MOBILECONFIG.write_bytes(plistlib.dumps(profile))


def generate_root_certificate():
    """生成本地根证书；根证书会被手机信任，因此有效期短于传统自签 CA"""
    run_openssl([
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-sha256",
        "-days",
        str(ROOT_CA_VALID_DAYS),
        "-nodes",
        "-keyout",
        str(ROOT_CA_KEY),
        "-out",
        str(ROOT_CA_PEM),
        "-subj",
        "/CN=GameBridge for Fun Local Root CA"
    ])


def generate_server_certificate():
    """按当前局域网 IP 生成服务器证书；手机浏览器会精确校验证书里的 IP"""
    run_openssl([
        "req",
        "-new",
        "-nodes",
        "-newkey",
        "rsa:2048",
        "-keyout",
        str(SERVER_CERT_KEY),
        "-out",
        str(SERVER_CERT_CSR),
        "-config",
        str(SERVER_CERT_CONFIG)
    ])
    run_openssl([
        "x509",
        "-req",
        "-in",
        str(SERVER_CERT_CSR),
        "-CA",
        str(ROOT_CA_PEM),
        "-CAkey",
        str(ROOT_CA_KEY),
        "-CAcreateserial",
        "-out",
        str(SERVER_CERT_PEM),
        "-days",
        str(SERVER_CERT_VALID_DAYS),
        "-sha256",
        "-extfile",
        str(SERVER_CERT_CONFIG),
        "-extensions",
        "req_ext"
    ])


def ensure_local_https_assets():
    """确保本地 HTTPS 证书存在；服务器证书随当前 IP 自动重签，私钥只保存在 certs/private"""
    global CERT_SHA256, CERT_ROOT_NOT_AFTER, CERT_SERVER_NOT_AFTER

    if not find_openssl_executable():
        print("HTTPS 已跳过: 未找到 openssl，无法生成本地证书")
        return False

    CERT_DIR.mkdir(exist_ok=True)
    CERT_PRIVATE_DIR.mkdir(exist_ok=True)

    try:
        existing_ip = CERT_IP_MARKER.read_text(encoding="utf-8").strip() if CERT_IP_MARKER.exists() else ""
        try:
            existing_policy = json.loads(CERT_POLICY_MARKER.read_text(encoding="utf-8")) if CERT_POLICY_MARKER.exists() else {}
        except (json.JSONDecodeError, OSError):
            existing_policy = {}

        root_exists = ROOT_CA_PEM.exists() and ROOT_CA_KEY.exists()
        server_exists = SERVER_CERT_PEM.exists() and SERVER_CERT_KEY.exists()

        # 根证书是手机手动信任的“总开关”。旧版本曾生成 10 年证书；
        # 这里会把明显过长或即将过期的根证书重建为当前策略，降低泄露后的可利用时间。
        root_remaining_days = certificate_remaining_days(ROOT_CA_PEM) if root_exists else -1
        root_too_long = root_remaining_days > ROOT_CA_VALID_DAYS + 2
        root_renew_window_days = min(7, max(1, ROOT_CA_VALID_DAYS // 10))
        root_expiring = certificate_expires_within(ROOT_CA_PEM, root_renew_window_days) if root_exists else True
        root_should_regenerate = (not root_exists) or root_too_long or root_expiring

        if root_should_regenerate:
            if root_exists:
                print("HTTPS 根证书已按当前安全策略重建；手机需要重新安装并信任根证书")
            generate_root_certificate()

        write_server_cert_config()

        # 服务器证书只证明当前这台电脑的 HTTPS 页面；它可以短期有效并频繁重签。
        server_policy_changed = existing_policy.get("server_valid_days") != SERVER_CERT_VALID_DAYS
        server_expiring = certificate_expires_within(SERVER_CERT_PEM, 1) if server_exists else True
        server_should_regenerate = (
            root_should_regenerate
            or (not server_exists)
            or existing_ip != CERTIFIED_LAN_IP
            or server_policy_changed
            or server_expiring
        )

        if server_should_regenerate:
            generate_server_certificate()
            CERT_IP_MARKER.write_text(CERTIFIED_LAN_IP, encoding="utf-8")

        run_openssl(["x509", "-in", str(ROOT_CA_PEM), "-outform", "DER", "-out", str(ROOT_CA_CER)])
        root_der = ROOT_CA_CER.read_bytes()
        build_mobileconfig(root_der)
        CERT_SHA256 = hashlib.sha256(root_der).hexdigest().upper()
        CERT_ROOT_NOT_AFTER = format_cert_time(ROOT_CA_PEM)
        CERT_SERVER_NOT_AFTER = format_cert_time(SERVER_CERT_PEM)

        CERT_POLICY_MARKER.write_text(
            json.dumps({
                "certified_ip": CERTIFIED_LAN_IP,
                "root_valid_days": ROOT_CA_VALID_DAYS,
                "server_valid_days": SERVER_CERT_VALID_DAYS,
                "root_not_after": CERT_ROOT_NOT_AFTER,
                "server_not_after": CERT_SERVER_NOT_AFTER,
                "generated_at": datetime.now(timezone.utc).isoformat()
            }, ensure_ascii=False, indent=2),
            encoding="utf-8"
        )

        for key_path in (ROOT_CA_KEY, SERVER_CERT_KEY):
            try:
                key_path.chmod(0o600)
            except OSError:
                pass

        return True
    except Exception as e:
        print(f"HTTPS 证书准备失败: {e}")
        return False


# --- 1. HTTP 静态文件托管服务 ---

def is_loopback_host(host):
    """判断主机名是否明确指向本机，供电脑控制台 WebSocket 鉴权使用"""
    if not host:
        return False
    if str(host).lower() == "localhost":
        return True

    try:
        return ipaddress.ip_address(str(host).split("%", 1)[0]).is_loopback
    except ValueError:
        return False


def is_valid_game_token(token):
    """使用恒定时间字节比较校验 token；非 ASCII 输入也只返回失败，不触发类型异常"""
    if not isinstance(token, str):
        return False
    return secrets.compare_digest(token.encode("utf-8"), GAME_ACCESS_TOKEN.encode("ascii"))


def is_console_request_authorized(websocket):
    """只允许本机控制台页面连接，防止同网段设备读取游戏 token 或直接发送试电命令"""
    remote_address = getattr(websocket, "remote_address", None)
    remote_host = remote_address[0] if remote_address else ""
    if not is_loopback_host(remote_host):
        return False

    request_headers = getattr(websocket, "request_headers", None)
    if not request_headers:
        return False
    try:
        # 浏览器只应发送一个 Origin；重复头可能让不同代理层产生不同理解，直接拒绝最稳妥。
        if hasattr(request_headers, "get_all"):
            origins = request_headers.get_all("Origin")
            if len(origins) != 1:
                return False
            origin = origins[0]
        else:
            origin = request_headers.get("Origin", "")
    except Exception:
        return False
    try:
        parsed_origin = urlparse(origin)
        origin_port = parsed_origin.port
    except (TypeError, ValueError):
        return False

    if not is_loopback_host(parsed_origin.hostname):
        return False

    # 控制台默认由本机 HTTP 页面打开；同时兼容用户主动用本机 HTTPS 地址访问控制台。
    allowed_http = parsed_origin.scheme == "http" and origin_port == HTTP_PORT
    allowed_https = HTTPS_ENABLED and parsed_origin.scheme == "https" and origin_port == HTTPS_PORT
    return allowed_http or allowed_https


class StaticHTTPRequestHandler(SimpleHTTPRequestHandler):
    """只公开网页资源与两份可安装证书，项目源码、Git 元数据和私钥全部不可访问"""

    # 不向局域网响应暴露 Python 版本，减少无意义的运行环境指纹。
    server_version = "GameBridgeForFun"
    sys_version = ""

    CERT_MIME_TYPES = {
        ".cer": "application/pkix-cert",
        ".mobileconfig": "application/x-apple-aspen-config",
        ".pem": "application/x-pem-file"
    }
    PUBLIC_CERTIFICATE_FILES = {
        ROOT_CA_CER.resolve(),
        ROOT_CA_MOBILECONFIG.resolve()
    }

    def __init__(self, *args, **kwargs):
        # 固定服务根目录，避免从其他目录执行 python3 server.py 时公开到错误位置。
        super().__init__(*args, directory=str(PROJECT_ROOT), **kwargs)

    def resolve_public_path(self, request_target=None):
        """把 URL 映射到允许公开的真实文件；路径穿越和符号链接越界都会被拒绝"""
        raw_path = unquote(urlparse(request_target or self.path).path)
        if raw_path in {"", "/"}:
            raw_path = "/static/index.html"
        if "\x00" in raw_path:
            return None

        try:
            candidate = (PROJECT_ROOT / raw_path.lstrip("/")).resolve()
            candidate.relative_to(STATIC_ROOT.resolve())
            return candidate
        except (OSError, RuntimeError, ValueError):
            pass

        try:
            candidate = (PROJECT_ROOT / raw_path.lstrip("/")).resolve()
        except (OSError, RuntimeError, ValueError):
            return None
        return candidate if candidate in self.PUBLIC_CERTIFICATE_FILES else None

    def translate_path(self, path):
        """让标准库继续负责文件传输，但文件位置只能来自上面的公开清单"""
        target = self.resolve_public_path(path)
        return str(target) if target else str(PROJECT_ROOT / ".http-not-found")

    def send_head(self):
        parsed_request = urlparse(self.path)
        if parsed_request.path in {"", "/"}:
            # 必须跳转而不是直接返回 HTML，否则相对引用的 style.css/console.js 会错误地请求到项目根目录。
            query_suffix = f"?{parsed_request.query}" if parsed_request.query else ""
            self.send_response(302)
            self.send_header("Location", f"/static/index.html{query_suffix}")
            self.end_headers()
            return None

        if self.resolve_public_path() is None:
            self.send_error(404, "resource is not public")
            return None
        return super().send_head()

    def list_directory(self, path):
        # 即使访问 static/ 之类的目录，也不向局域网暴露文件清单。
        self.send_error(404, "directory listing is disabled")
        return None

    def end_headers(self):
        # token 存在于游戏页 URL；禁止浏览器把完整来源地址转发给后续资源或外部页面。
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        # 页面仍使用本地内联事件和样式，因此保留 unsafe-inline；其余资源只能来自本机，且禁止插件对象和外部跳转表单。
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self' 'unsafe-inline'; "
            "style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
            "connect-src ws: wss:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
        )
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def guess_type(self, path):
        ext = Path(path).suffix.lower()
        if ext in self.CERT_MIME_TYPES:
            return self.CERT_MIME_TYPES[ext]
        return super().guess_type(path)

    def log_message(self, format, *args):
        # 覆写空函数，不输出冗余的 HTTP GET/POST 日志
        pass


class BoundedThreadingHTTPServer(ThreadingHTTPServer):
    """限制局域网慢连接占用时间，退出时也不等待卡住的请求线程"""

    daemon_threads = True
    request_queue_size = 32

    def get_request(self):
        request, client_address = super().get_request()
        request.settimeout(10)
        return request, client_address


def run_http_server():
    """多线程托管 HTTP 服务"""
    global http_server_instance, HTTP_PORT
    try:
        HTTP_PORT = find_free_port(HTTP_PORT)
        server_address = ("", HTTP_PORT)
        http_server_instance = BoundedThreadingHTTPServer(server_address, StaticHTTPRequestHandler)

        print(f"HTTP 服务已启动: 端口 {HTTP_PORT}")
        http_server_ready.set()
        http_server_instance.serve_forever()
    except Exception as error:
        print(f"HTTP 服务启动失败: {error}")
        http_server_ready.set()


def run_https_server():
    """多线程托管 HTTPS 服务，供 iPhone 传感器玩法使用"""
    global https_server_instance, HTTPS_PORT, HTTPS_ENABLED

    if not ensure_local_https_assets():
        HTTPS_ENABLED = False
        https_server_ready.set()
        return

    try:
        HTTPS_PORT = find_free_port(HTTPS_PORT)
        server_address = ("", HTTPS_PORT)
        https_server_instance = BoundedThreadingHTTPServer(server_address, StaticHTTPRequestHandler)
        ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ssl_context.load_cert_chain(str(SERVER_CERT_PEM), str(SERVER_CERT_KEY))
        https_server_instance.socket = ssl_context.wrap_socket(
            https_server_instance.socket,
            server_side=True
        )
        HTTPS_ENABLED = True
        print(f"HTTPS 服务已启动: 端口 {HTTPS_PORT}，证书 IP: {CERTIFIED_LAN_IP}")
        https_server_ready.set()
        https_server_instance.serve_forever()
    except Exception as e:
        HTTPS_ENABLED = False
        print(f"HTTPS 服务启动失败: {e}")
        if https_server_instance:
            https_server_instance.server_close()
            https_server_instance = None
        https_server_ready.set()


# --- 2. WebSocket 广播函数 ---

def build_state_message(include_console_details=False):
    """构造最小状态包；只有本机控制台能收到配对密钥、App 二维码与证书详情"""
    message = {
        "type": "state_update",
        "local_ip": LOCAL_IP,
        "http_port": HTTP_PORT,
        "web_ws_port": WEB_WS_PORT,
        "app_ws_port": APP_WS_PORT,
        "app_connected": state["app_connected"],
        "device_connected": state["device_connected"],
        "app_latency": state["app_latency"],
        "game_latency": state["game_latency"],
        "strength_a": state["client_strength_a"],
        "strength_b": state["client_strength_b"],
        "limit_a": state["limit_a"],
        "limit_b": state["limit_b"],
        "battery_level": state["battery_level"],
        "bridge_protocol": state["bridge_protocol"],
        "device_type": state["device_type"],
        "device_model": state["device_model"],
        "device_name": state["device_name"],
        "device_status_message": state["device_status_message"],
        "muted_a": state["muted_a"],
        "muted_b": state["muted_b"],
        "overheat_a": state["overheat_a"],
        "overheat_b": state["overheat_b"],
        "channel_status_a": state["channel_status_a"],
        "channel_status_b": state["channel_status_b"],
        "game_connected": state["game_client_connected"]
    }
    if include_console_details:
        message.update({
            "https_enabled": HTTPS_ENABLED,
            "https_port": HTTPS_PORT if HTTPS_ENABLED else None,
            "secure_web_ws_port": SECURE_WEB_WS_PORT if HTTPS_ENABLED else None,
            "certified_lan_ip": CERTIFIED_LAN_IP,
            "cert_ip_mode": "手动指定" if CERT_IP_OVERRIDE else "自动检测",
            "cert_sha256": CERT_SHA256,
            "cert_root_not_after": CERT_ROOT_NOT_AFTER,
            "cert_server_not_after": CERT_SERVER_NOT_AFTER,
            "cert_root_valid_days": ROOT_CA_VALID_DAYS,
            "cert_server_valid_days": SERVER_CERT_VALID_DAYS,
            "cert_profile_path": ROOT_CA_MOBILECONFIG_URL_PATH,
            "cert_cer_path": ROOT_CA_CER_URL_PATH,
            "game_token": GAME_ACCESS_TOKEN,
            "app_qrcode_url": state["app_qrcode_url"],
            "selected_device_id": state["selected_device_id"],
            "selection_required": state["selection_required"],
            "compatible_devices": [
                {
                    "selection_id": device.get("selection_id"),
                    "name": device.get("name"),
                    "type": device.get("type"),
                    "model": device.get("model"),
                    "connected": bool(device.get("connected")),
                    "selected": bool(device.get("selected")),
                }
                for device in state["compatible_devices"]
            ],
        })
    return message


async def broadcast_state():
    """向控制台和手机游戏页同步当前的最新连接状态、端口与硬件读数"""
    async with state_lock:
        console_payload = json.dumps(build_state_message(include_console_details=True))
        game_payload = json.dumps(build_state_message(include_console_details=False))
    if console_connections:
        await asyncio.gather(*(c.send(console_payload) for c in tuple(console_connections)), return_exceptions=True)
    if game_connections:
        await asyncio.gather(*(c.send(game_payload) for c in tuple(game_connections)), return_exceptions=True)


# --- 3. 设备 App 桥接后台协程 ---

async def monitor_app_latency(client):
    """周期性测量电脑到 DG-LAB App 的完整 V4 应用层往返延迟。"""
    global state
    while True:
        if state["app_connected"] and client.has_app:
            try:
                state["app_latency"] = await client.measure_latency()
            except Exception:
                state["app_latency"] = -1
            await broadcast_state()
        else:
            state["app_latency"] = -1
        await asyncio.sleep(2)


async def apply_v4_bridge_state(snapshot):
    """把 V4 设备快照映射到现有电脑、网页和 Android 共用的状态协议。"""
    previous_device_connected = state["device_connected"]
    previous_selected_device = state["selected_device_id"]
    had_active_output = bool(
        active_output_task
        or (isinstance(state["client_strength_a"], int) and state["client_strength_a"] > 0)
        or (isinstance(state["client_strength_b"], int) and state["client_strength_b"] > 0)
    )

    state["app_connected"] = snapshot["app_connected"]
    state["device_connected"] = snapshot["device_connected"]
    state["client_strength_a"] = snapshot["client_strength_a"]
    state["client_strength_b"] = snapshot["client_strength_b"]
    state["limit_a"] = snapshot["limit_a"]
    state["limit_b"] = snapshot["limit_b"]
    state["battery_level"] = snapshot["battery_level"]
    state["bridge_protocol"] = snapshot["bridge_protocol"]
    state["device_type"] = snapshot["device_type"]
    state["device_model"] = snapshot["device_model"]
    state["device_name"] = snapshot["device_name"]
    state["device_status_message"] = snapshot["device_status_message"]
    state["selected_device_id"] = snapshot["selected_device_id"]
    state["selection_required"] = snapshot["selection_required"]
    state["compatible_devices"] = snapshot["devices"]
    state["muted_a"] = snapshot["muted_a"]
    state["muted_b"] = snapshot["muted_b"]
    state["overheat_a"] = snapshot["overheat_a"]
    state["overheat_b"] = snapshot["overheat_b"]
    state["channel_status_a"] = snapshot["channel_status_a"]
    state["channel_status_b"] = snapshot["channel_status_b"]

    became_unsafe = (
        (previous_device_connected and not state["device_connected"])
        or (
            previous_selected_device
            and previous_selected_device != state["selected_device_id"]
        )
        or state["overheat_a"]
        or state["overheat_b"]
        or state["muted_a"]
        or state["muted_b"]
        or state["channel_status_a"] in {3, 4}
        or state["channel_status_b"] in {3, 4}
    )
    if became_unsafe and had_active_output:
        # 回调运行在 App 的接收循环中，不能原地等待停止 RPC 回执，否则接收循环会等自己。
        asyncio.create_task(stop_all_output())

    await broadcast_state()


async def handle_v4_action(action):
    """把 DG-LAB 4 App 的 0-9 自定义动作继续广播给原有前端。"""
    button_message = json.dumps({"type": "button_feedback", "button": str(action)})
    recipients = tuple(console_connections) + tuple(game_connections)
    if recipients:
        await asyncio.gather(*(connection.send(button_message) for connection in recipients), return_exceptions=True)


def reset_v4_state(clear_qrcode=False):
    """App 桥接重启或退出时清理所有可能误导用户的硬件读数。"""
    state.update({
        "app_connected": False,
        "device_connected": False,
        "app_latency": -1,
        "client_strength_a": 0,
        "client_strength_b": 0,
        "limit_a": None,
        "limit_b": None,
        "battery_level": None,
        "device_type": None,
        "device_model": None,
        "device_name": None,
        "device_status_message": "等待 DG-LAB 4 App 扫码",
        "selected_device_id": None,
        "selection_required": False,
        "compatible_devices": [],
        "muted_a": False,
        "muted_b": False,
        "overheat_a": False,
        "overheat_b": False,
        "channel_status_a": None,
        "channel_status_b": None,
    })
    if clear_qrcode:
        state["app_qrcode_url"] = ""


async def app_bridge_runner():
    """运行本地 V4 Socket 网关；异常退出后自动换用可用端口重建。"""
    global device_app_client, state, APP_WS_PORT

    while True:
        APP_WS_PORT = find_free_port(APP_WS_PORT)
        bridge = DGLabV4Bridge(
            state_callback=apply_v4_bridge_state,
            action_callback=handle_v4_action,
        )
        app_server = None
        latency_task = None

        try:
            app_server = await websockets.serve(
                bridge.handle_connection,
                "0.0.0.0",
                APP_WS_PORT,
                compression=None,
                max_size=MAX_APP_MESSAGE_BYTES,
                max_queue=MAX_WEB_MESSAGE_QUEUE,
                ping_interval=10,
                ping_timeout=10,
                close_timeout=2,
            )
            device_app_client = bridge
            state["app_qrcode_url"] = bridge.pairing_url(LOCAL_IP, APP_WS_PORT)
            reset_v4_state(clear_qrcode=False)
            latency_task = asyncio.create_task(monitor_app_latency(bridge))
            print(f"DG-LAB App V4 网关已启动: 端口 {APP_WS_PORT}")
            await broadcast_state()
            await asyncio.Future()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            print(f"DG-LAB App V4 桥接运行异常: {e}")
        finally:
            if latency_task:
                latency_task.cancel()
                await asyncio.gather(latency_task, return_exceptions=True)
            await bridge.close()
            if app_server:
                app_server.close()
                await app_server.wait_closed()
            reset_v4_state(clear_qrcode=True)
            device_app_client = None
            await broadcast_state()

        await asyncio.sleep(1)


# --- 4. 网页端控制台与手机小游戏 WebSocket 服务 (8081端口) ---

def clamp_int(value, minimum, maximum, fallback=0):
    """把外部输入压成安全整数，防止字符串、空值、超大值直接进入硬件控制逻辑"""
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError):
        number = fallback
    return max(minimum, min(maximum, number))


def parse_output_config(data):
    """解析游戏端传来的输出通道配置，默认只使用 A 通道"""
    output_mode = data.get("outputMode", data.get("output_mode", "a"))
    if output_mode not in {"a", "b", "ab"}:
        output_mode = "a"

    b_strength_mode = data.get("bStrengthMode", data.get("b_strength_mode", "percent"))
    if b_strength_mode not in {"same", "percent"}:
        b_strength_mode = "percent"

    b_strength_percent = clamp_int(
        data.get("bStrengthPercent", data.get("b_strength_percent", 50)),
        10,
        100,
        fallback=50
    )
    return output_mode, b_strength_mode, b_strength_percent


def build_channel_strengths(base_strength, output_mode, b_strength_mode, b_strength_percent):
    """把游戏强度换算成 A/B 两路最终强度，并分别套用设备限幅"""
    base = clamp_int(base_strength, 0, 200, fallback=0)
    if base <= 0:
        return []

    # 限幅未回传或明确为 0 时，该通道保持关闭。这里采用“未知即拒绝”，不能擅自回退到协议最大值 200。
    limit_a = clamp_int(state.get("limit_a"), 0, 200, fallback=0)
    limit_b = clamp_int(state.get("limit_b"), 0, 200, fallback=0)
    if output_mode in {"a", "ab"} and limit_a <= 0:
        return []
    if output_mode in {"b", "ab"} and limit_b <= 0:
        return []

    targets = []

    if output_mode in {"a", "ab"}:
        targets.append((Channel.A, min(base, limit_a), "client_strength_a"))

    if output_mode in {"b", "ab"}:
        b_base = base if b_strength_mode == "same" else round(base * b_strength_percent / 100)
        targets.append((Channel.B, min(clamp_int(b_base, 0, 200, fallback=0), limit_b), "client_strength_b"))

    return [(channel, strength, state_key) for channel, strength, state_key in targets if strength > 0]


async def clear_all_output_locked():
    """在持有 shock_lock 时逐路清空；返回两路停止命令是否全部得到确认"""
    if not device_app_client:
        state["client_strength_a"] = 0
        state["client_strength_b"] = 0
        return True
    if not state["device_connected"]:
        # App 仍在线但没有可定位设备时无法确认硬件归零，必须向界面如实报告失败。
        unknown_value = None if state["app_connected"] else 0
        state["client_strength_a"] = unknown_value
        state["client_strength_b"] = unknown_value
        return not state["app_connected"]

    errors = []
    channel_states = (
        (Channel.A, "client_strength_a"),
        (Channel.B, "client_strength_b"),
    )
    for channel, state_key in channel_states:
        channel_errors = []
        try:
            await asyncio.wait_for(
                device_app_client.clear_pulses(channel),
                timeout=HARDWARE_COMMAND_TIMEOUT_SECONDS
            )
        except Exception as error:
            channel_errors.append(f"清波形失败: {error}")
        try:
            # 即使清任务失败，也继续使用独立的 V4 归零任务，并且不会因此跳过另一通道。
            await asyncio.wait_for(
                device_app_client.reset_strength(channel),
                timeout=HARDWARE_COMMAND_TIMEOUT_SECONDS
            )
        except Exception as error:
            channel_errors.append(f"强度归零失败: {error}")

        if channel_errors:
            # 未得到完整停止确认时不能向界面谎报为 0；None 会显示为“未读取”。
            state[state_key] = None
            errors.append(f"{channel}: {', '.join(channel_errors)}")
        else:
            state[state_key] = 0
    if errors:
        print(f"停止输出未全部成功: {'; '.join(errors)}")
    return not errors


def disarm_output_watchdog():
    """撤销游戏页输出看门狗；代际号可让已经醒来的旧任务失效，避免误停后续新输出"""
    global output_watchdog_task, output_watchdog_owner, output_watchdog_mode, output_watchdog_generation
    output_watchdog_generation += 1
    task = output_watchdog_task
    output_watchdog_task = None
    output_watchdog_owner = None
    output_watchdog_mode = None
    if task and not task.done():
        task.cancel()


async def run_output_watchdog(generation, owner, timeout_seconds):
    """等待游戏页续报；超时后不再相信浏览器状态，直接执行后端硬停机"""
    global output_watchdog_task, output_watchdog_owner
    try:
        await asyncio.sleep(timeout_seconds)
    except asyncio.CancelledError:
        return

    if generation != output_watchdog_generation or owner is not output_watchdog_owner:
        return

    # 先摘除自身引用，防止 stop_all_output 在同一个任务里反向取消自己。
    output_watchdog_task = None
    output_watchdog_owner = None
    print("游戏页输出心跳超时，已自动停止 A/B 两路输出")
    await stop_all_output()
    await broadcast_state()


def arm_output_watchdog(owner, mode="page"):
    """设置输出责任方；长时任务看页面心跳，持续玩法只看新的脉冲请求"""
    global output_watchdog_task, output_watchdog_owner, output_watchdog_mode, output_watchdog_generation
    if mode not in {"page", "continuous"}:
        raise ValueError("未知输出看门狗模式")
    disarm_output_watchdog()
    output_watchdog_generation += 1
    generation = output_watchdog_generation
    output_watchdog_owner = owner
    output_watchdog_mode = mode
    timeout_seconds = (
        CONTINUOUS_OUTPUT_IDLE_TIMEOUT_SECONDS
        if mode == "continuous"
        else OUTPUT_HEARTBEAT_TIMEOUT_SECONDS
    )
    output_watchdog_task = asyncio.create_task(
        run_output_watchdog(generation, owner, timeout_seconds)
    )


def refresh_output_watchdog(owner):
    """普通页面消息只给长时结算续期；持续短脉冲必须由新 game_pulse 明确续期"""
    if (
        owner is output_watchdog_owner
        and output_watchdog_mode == "page"
        and output_watchdog_task
        and not output_watchdog_task.done()
    ):
        arm_output_watchdog(owner, mode="page")


def on_output_task_done(task):
    """释放当前任务引用；会自行清零的结算任务完成后不再需要页面心跳兜底"""
    global active_output_task, active_output_clear_after
    if active_output_task is task:
        should_disarm = active_output_clear_after
        active_output_task = None
        active_output_clear_after = True
        if should_disarm:
            disarm_output_watchdog()


def schedule_game_shock(
    strength,
    duration_ms,
    output_mode="a",
    b_strength_mode="percent",
    b_strength_percent=50,
    clear_after=True
):
    """最多保留一个硬件输出任务，防止异常页面把 60 秒任务无限堆进内存"""
    global active_output_task, active_output_clear_after
    if not state["device_connected"] or not device_app_client:
        return False
    if not build_channel_strengths(strength, output_mode, b_strength_mode, b_strength_percent):
        return False
    if active_output_task and not active_output_task.done():
        return False

    active_output_task = asyncio.create_task(handle_game_shock(
        strength,
        duration_ms,
        output_mode,
        b_strength_mode,
        b_strength_percent,
        clear_after
    ))
    active_output_clear_after = clear_after
    active_output_task.add_done_callback(on_output_task_done)
    return True


async def stop_all_output():
    """立即取消当前任务并串行清空 A/B 两路，避免停止命令与脉冲下发交叉执行"""
    global shock_generation, active_output_task, active_output_clear_after
    shock_generation += 1
    disarm_output_watchdog()

    running_task = active_output_task
    current_task = asyncio.current_task()
    if running_task and running_task is not current_task and not running_task.done():
        running_task.cancel()
        await asyncio.gather(running_task, return_exceptions=True)
        if active_output_task is running_task:
            active_output_task = None
            active_output_clear_after = True

    async with shock_lock:
        return await clear_all_output_locked()


async def handle_game_shock(
    strength,
    duration_ms,
    output_mode="a",
    b_strength_mode="percent",
    b_strength_percent=50,
    clear_after=True
):
    """向 App 客户端下发一段受限脉冲；所有硬件写入都在同一把锁内串行执行"""
    global device_app_client, state, shock_generation
    if not state["device_connected"] or not device_app_client:
        return
    
    try:
        # A/B 通道各自遵循 0-200，且不能超过 App/设备端软上限。
        channel_targets = build_channel_strengths(strength, output_mode, b_strength_mode, b_strength_percent)
        safe_duration = clamp_int(
            duration_ms,
            MIN_SHOCK_DURATION_MS,
            MAX_SHOCK_DURATION_MS,
            fallback=MIN_SHOCK_DURATION_MS
        )
        if not channel_targets:
            return

        # 向上取整，确保 101-199ms 这类时长不会被错误缩短到单帧；最后仍由临时强度期限兜底。
        loops = max(1, math.ceil(safe_duration / 100))
        generation = shock_generation

        async with shock_lock:
            if not state["device_connected"] or generation != shock_generation:
                return

            # V4 的 device.op 只在任务结束时回执，因此非零强度和波形必须并发排入 App，
            # 不能像旧 V3 那样逐条等回执。每条非零强度都带自动过期时间，作为断线后的独立保险。
            for channel, safe_strength, state_key in channel_targets:
                await asyncio.wait_for(
                    device_app_client.set_temporary_strength(
                        channel,
                        safe_strength,
                        safe_duration + OUTPUT_AUTO_RESET_MARGIN_MS,
                    ),
                    timeout=HARDWARE_COMMAND_TIMEOUT_SECONDS
                )
                state[state_key] = safe_strength

            for _ in range(loops):
                if not state["device_connected"] or generation != shock_generation:
                    break
                for channel, safe_strength, _state_key in channel_targets:
                    await asyncio.wait_for(
                        device_app_client.send_pulse(channel, safe_strength, duration_ms=100),
                        timeout=HARDWARE_COMMAND_TIMEOUT_SECONDS
                    )
                await asyncio.sleep(0.1)

            # 结算型惩罚结束后在同一把锁内清空，避免结束动作和下一条硬件写入交叉。
            if clear_after:
                await clear_all_output_locked()
    except asyncio.CancelledError:
        # 紧急停止会取消当前任务，再取得同一把锁清空硬件；取消必须继续向上传递，不能伪装成正常结束。
        raise
    except Exception as e:
        print(f"脉冲下发失败: {e}")
        # 任一步硬件写入失败都进入停止流程，不能让已成功设置的另一通道留在非零强度。
        async with shock_lock:
            await clear_all_output_locked()


async def send_test_feedback(websocket, ok, message):
    """向发起测试的网页单独返回结果，避免把测试按钮状态广播给所有页面"""
    try:
        await websocket.send(json.dumps({
            "type": "test_feedback",
            "ok": ok,
            "message": message
        }))
    except websockets.exceptions.ConnectionClosed:
        pass


async def send_stop_feedback(websocket, ok):
    """明确告知页面停止命令是否得到两路硬件确认，失败时要求用户转到设备 App 处理"""
    message = (
        "A/B 两路停止命令已确认"
        if ok
        else "停止命令未全部确认，请立即在设备 App 中停止输出并检查连接"
    )
    try:
        await websocket.send(json.dumps({
            "type": "stop_feedback",
            "ok": ok,
            "message": message
        }))
    except websockets.exceptions.ConnectionClosed:
        pass


async def send_device_feedback(websocket, ok, message):
    """向本机控制台返回设备选择结果，不把设备内部 ID 广播给游戏端。"""
    try:
        await websocket.send(json.dumps({
            "type": "device_feedback",
            "ok": ok,
            "message": message,
        }))
    except websockets.exceptions.ConnectionClosed:
        pass


async def handle_test_shock_request(websocket, data):
    """处理连接测试的低强度试电请求；后端强制限幅，不能被前端参数绕过"""
    global last_test_shock_at

    now = asyncio.get_running_loop().time()
    remaining = TEST_COOLDOWN_SECONDS - (now - last_test_shock_at)
    if remaining > 0:
        await send_test_feedback(websocket, False, f"测试冷却中，约 {remaining:.1f}s 后再试")
        return

    if not state["device_connected"] or not device_app_client:
        await send_test_feedback(websocket, False, "郊狼设备尚未连接并就绪，无法试电")
        return

    strength = clamp_int(data.get("strength", 5), 1, TEST_MAX_STRENGTH, fallback=5)
    duration = clamp_int(data.get("duration", 300), MIN_SHOCK_DURATION_MS, TEST_MAX_DURATION_MS, fallback=300)
    output_mode, b_strength_mode, b_strength_percent = parse_output_config(data)
    scheduled = schedule_game_shock(
        strength,
        duration,
        output_mode,
        b_strength_mode,
        b_strength_percent,
        clear_after=True
    )
    if not scheduled:
        await send_test_feedback(websocket, False, "输出忙，或所选通道限幅尚未读取/已设为 0")
        return

    last_test_shock_at = now
    await send_test_feedback(websocket, True, f"已发送安全试电：{strength} 强度，{duration / 1000:.1f}s")


async def web_ws_handler(websocket, path):
    """处理来自电脑控制台网页 (/console) 与手机小游戏网页 (/game) 的连接"""
    global state

    parsed_path = urlparse(path or "/")
    route = parsed_path.path

    if route == "/console":
        if not is_console_request_authorized(websocket):
            try:
                await websocket.close(code=1008, reason="console is local only")
            except websockets.exceptions.ConnectionClosed:
                pass
            return

        console_connections.add(websocket)
        # 连入后立即同步一次最新状态
        await broadcast_state()
        try:
            async for message in websocket:
                try:
                    data = json.loads(message)
                except json.JSONDecodeError:
                    continue
                if not isinstance(data, dict):
                    continue
                
                # 如果收到端口更改命令，提示重载 (由于是在后台修改，我们输出指令)
                if data.get("type") == "change_ports":
                    print(f"收到端口更改请求: WebWS={data.get('web_ws_port')}")
                    await websocket.send(json.dumps({
                        "type": "port_change_unsupported",
                        "message": "当前版本不支持运行中热切端口"
                    }))
                elif data.get("type") == "test_shock":
                    await handle_test_shock_request(websocket, data)
                elif data.get("type") == "stop_shock":
                    stopped = await stop_all_output()
                    await broadcast_state()
                    await send_stop_feedback(websocket, stopped)
                elif data.get("type") == "select_device":
                    selection_id = data.get("selectionId")
                    if not isinstance(selection_id, str) or not device_app_client:
                        await send_device_feedback(websocket, False, "设备选择请求无效")
                        continue

                    # 从一台设备切到另一台之前必须确认旧设备已经停止，禁止带电切换控制目标。
                    if state["device_connected"] and state["selected_device_id"] != selection_id:
                        stopped = await stop_all_output()
                        if not stopped:
                            await send_device_feedback(
                                websocket,
                                False,
                                "旧设备停止指令未确认，已拒绝切换；请先在 App 中手动停止",
                            )
                            continue
                    try:
                        await device_app_client.select_device(selection_id)
                        await send_device_feedback(websocket, True, "控制目标已确认")
                    except DeviceBridgeError as error:
                        await send_device_feedback(websocket, False, str(error))
                    
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            console_connections.discard(websocket)
            
    elif route == "/game":
        query = parse_qs(parsed_path.query)
        token = query.get("token", [""])[0]
        if not is_valid_game_token(token):
            try:
                # 无 token 页面会被立即拒绝；如果浏览器已经主动断开，不再把正常拒绝打印成异常栈。
                await websocket.close(code=1008, reason="invalid game token")
            except websockets.exceptions.ConnectionClosed:
                pass
            return

        game_connections.add(websocket)
        state["game_client_connected"] = True
        await broadcast_state()
        
        try:
            async for message in websocket:
                try:
                    data = json.loads(message)
                except json.JSONDecodeError:
                    continue
                if not isinstance(data, dict):
                    continue

                # 输出看门狗只认发起输出的这一条游戏连接。正常页面每秒至少发送一次 ping，
                # 页面冻结或网络半断开时不会再续报，后端会在硬期限内自动归零。
                refresh_output_watchdog(websocket)
                
                # 网页自定义应用层 Ping 延迟包，原样回复
                if data.get("type") == "ping":
                    pong_msg = json.dumps({"type": "pong", "time": data.get("time")})
                    await websocket.send(pong_msg)
                    
                # 网页上报的 RTT 延迟数据，广播给电脑控制台展示
                elif data.get("type") == "latency_report":
                    state["game_latency"] = clamp_int(data.get("rtt"), -1, 60000, fallback=-1)
                    report_msg = json.dumps({
                        "type": "game_latency",
                        "latency": state["game_latency"]
                    })
                    if console_connections:
                        await asyncio.gather(*(c.send(report_msg) for c in console_connections), return_exceptions=True)
                    await broadcast_state()

                elif data.get("type") == "test_shock":
                    await handle_test_shock_request(websocket, data)
                
                # 游戏 1 / 游戏 2 的持续线性惩罚数据上报 (每 100ms 触发一次)
                elif data.get("type") == "game_pulse":
                    now = asyncio.get_running_loop().time()
                    last_pulse_at = game_connection_last_pulse_at.get(websocket)
                    # “从未发送”不能伪装成时间 0；部分事件循环从 0 开始计时，否则服务刚启动时会吞掉首帧。
                    if last_pulse_at is not None and now - last_pulse_at < MIN_PULSE_INTERVAL_SECONDS:
                        continue
                    game_connection_last_pulse_at[websocket] = now

                    strength = clamp_int(data.get("strength", 0), 0, 200, fallback=0)
                    duration = clamp_int(data.get("duration", 120), 100, 500, fallback=120)
                    if strength > 0:
                        output_mode, b_strength_mode, b_strength_percent = parse_output_config(data)
                        scheduled = schedule_game_shock(
                            strength,
                            duration,
                            output_mode,
                            b_strength_mode,
                            b_strength_percent,
                            clear_after=False
                        )
                        if scheduled:
                            arm_output_watchdog(websocket, mode="continuous")
                        
                # 结算型惩罚上报：骰子、角子机满槽和角子机轻惩罚都走这里。
                elif data.get("type") == "game_shock_trigger":
                    strength = clamp_int(data.get("strength", 0), 0, 200, fallback=0)
                    duration = clamp_int(
                        data.get("duration", 1000),
                        MIN_SHOCK_DURATION_MS,
                        MAX_SHOCK_DURATION_MS,
                        fallback=1000
                    )
                    if strength > 0:
                        output_mode, b_strength_mode, b_strength_percent = parse_output_config(data)
                        # 单任务调度器会拒绝重叠请求，避免把长时输出无限排队。
                        scheduled = schedule_game_shock(
                            strength,
                            duration,
                            output_mode,
                            b_strength_mode,
                            b_strength_percent,
                            clear_after=True
                        )
                        if scheduled:
                            arm_output_watchdog(websocket)

                elif data.get("type") == "stop_shock":
                    stopped = await stop_all_output()
                    await broadcast_state()
                    await send_stop_feedback(websocket, stopped)
                        
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            game_connections.discard(websocket)
            game_connection_last_pulse_at.pop(websocket, None)
            state["game_client_connected"] = len(game_connections) > 0
            if not state["game_client_connected"]:
                state["game_latency"] = -1
            try:
                await stop_all_output()
            except Exception as error:
                # 连接清理不能因为一次停止异常跳过状态广播；临时强度自动到期仍是最后保险。
                print(f"游戏页断开后的停止流程异常: {error}")
            await broadcast_state()
    else:
        await websocket.close(code=1008, reason="unknown route")


async def run_web_ws_server():
    """启动小游戏与网页控制台的局域网 WS 服务器"""
    global web_ws_server_instance, WEB_WS_PORT
    WEB_WS_PORT = find_free_port(WEB_WS_PORT)
    
    server = await websockets.serve(
        web_ws_handler,
        "0.0.0.0",
        WEB_WS_PORT,
        compression=None,
        max_size=MAX_WEB_MESSAGE_BYTES,
        max_queue=MAX_WEB_MESSAGE_QUEUE
    )
    web_ws_server_instance = server
    print(f"网页 WS 交互服务已启动: 端口 {WEB_WS_PORT}")


async def run_secure_web_ws_server():
    """启动 HTTPS 页面专用的 WSS 服务器"""
    global secure_web_ws_server_instance, SECURE_WEB_WS_PORT
    if not HTTPS_ENABLED:
        return

    ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ssl_context.load_cert_chain(str(SERVER_CERT_PEM), str(SERVER_CERT_KEY))
    SECURE_WEB_WS_PORT = find_free_port(SECURE_WEB_WS_PORT)

    secure_web_ws_server_instance = await websockets.serve(
        web_ws_handler,
        "0.0.0.0",
        SECURE_WEB_WS_PORT,
        ssl=ssl_context,
        compression=None,
        max_size=MAX_WEB_MESSAGE_BYTES,
        max_queue=MAX_WEB_MESSAGE_QUEUE
    )
    print(f"网页 WSS 安全通信服务已启动: 端口 {SECURE_WEB_WS_PORT}")


async def shutdown_services(app_task=None):
    """按安全顺序停止硬件输出与各服务，避免退出进程时只依赖连接断开兜底"""
    try:
        await stop_all_output()
    except Exception as error:
        print(f"退出时停止硬件输出失败: {error}")

    if app_task:
        app_task.cancel()
        await asyncio.gather(app_task, return_exceptions=True)

    websocket_servers = tuple(
        server_instance
        for server_instance in (web_ws_server_instance, secure_web_ws_server_instance)
        if server_instance is not None
    )
    for server_instance in websocket_servers:
        server_instance.close()
    if websocket_servers:
        await asyncio.gather(
            *(server_instance.wait_closed() for server_instance in websocket_servers),
            return_exceptions=True
        )

    loop = asyncio.get_running_loop()
    for server_instance in (http_server_instance, https_server_instance):
        if server_instance is None:
            continue
        await loop.run_in_executor(None, server_instance.shutdown)
        server_instance.server_close()


# --- 5. 系统初始化主协程 ---

async def main():
    global LOCAL_IP, CERTIFIED_LAN_IP, state_lock, shock_lock
    app_task = None
    shutdown_event = asyncio.Event()
    registered_signals = []
    loop = asyncio.get_running_loop()

    # Python 3.9 的异步锁会绑定首次真正等待它的事件循环。服务启动后在当前主循环内重建，
    # 避免模块导入、测试循环或多页面同时断开时拿到属于旧循环的 Future。
    state_lock = asyncio.Lock()
    shock_lock = asyncio.Lock()

    # 双击启动后的终端关闭、Ctrl+C 和系统结束进程都会先唤醒同一条安全退出路径。
    # SIGKILL 无法被任何程序捕获，因此真实设备验收仍必须覆盖设备 App 内的人工停止。
    for shutdown_signal in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        try:
            loop.add_signal_handler(shutdown_signal, shutdown_event.set)
            registered_signals.append(shutdown_signal)
        except (NotImplementedError, RuntimeError, ValueError):
            # 非 macOS/Unix 环境可能不支持异步信号处理；保留原有 KeyboardInterrupt 兜底。
            continue

    if RAW_CERT_IP_OVERRIDE and not CERT_IP_OVERRIDE:
        print("已忽略无效的证书 IP 环境变量：只接受 10.x、172.16-31.x 或 192.168.x IPv4")
    LOCAL_IP = get_local_ip()
    CERTIFIED_LAN_IP = CERT_IP_OVERRIDE or LOCAL_IP
    
    print("=" * 45)
    print("GameBridge for Fun - 控制台")
    print(f"本地局域网 IP 地址: {LOCAL_IP}")
    print(f"HTTPS 证书签发 IP: {CERTIFIED_LAN_IP} ({'手动指定' if CERT_IP_OVERRIDE else '自动检测'})")
    print("=" * 45)

    try:
        # 1. 启动 HTTP 托管线程
        http_thread = threading.Thread(target=run_http_server, daemon=True)
        http_thread.start()
        await asyncio.get_running_loop().run_in_executor(None, http_server_ready.wait)
        if http_server_instance is None:
            raise RuntimeError("HTTP 服务未能启动")

        # 2. 启动 HTTPS 托管线程。iPhone 传感器权限依赖安全页面，失败时不影响普通 HTTP 玩法。
        https_thread = threading.Thread(target=run_https_server, daemon=True)
        https_thread.start()
        await asyncio.get_running_loop().run_in_executor(None, https_server_ready.wait)

        # 3. 启动网页 WebSocket 交互服务
        await run_web_ws_server()
        await run_secure_web_ws_server()

        # 4. 后台启动设备 App 远控网关及绑定桥接
        app_task = asyncio.create_task(app_bridge_runner())

        # 5. 运行环境就绪后，在电脑端自动打开浏览器控制台
        print("服务已启动")
        if not DISABLE_AUTO_BROWSER:
            webbrowser.open(f"http://127.0.0.1:{HTTP_PORT}/static/index.html?ws={WEB_WS_PORT}")
        if HTTPS_ENABLED:
            print(f"手机证书安装页: http://{LOCAL_IP}:{HTTP_PORT}/static/index.html?ws={WEB_WS_PORT}")
            print(f"手机 HTTPS 游戏页: https://{CERTIFIED_LAN_IP}:{HTTPS_PORT}/static/game.html?ws={SECURE_WEB_WS_PORT}&token={GAME_ACCESS_TOKEN}")

        # 6. 挂起主协程，直到系统信号要求按安全顺序停止输出和所有服务。
        await shutdown_event.wait()
        print("正在安全停止服务...")
    finally:
        await shutdown_services(app_task)
        for shutdown_signal in registered_signals:
            loop.remove_signal_handler(shutdown_signal)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n服务已退出")
