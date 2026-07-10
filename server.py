# -*- coding: utf-8 -*-
"""
DG-LAB 郊狼小游戏选择器中转系统 - 后端核心服务端 (重构适配版)
"""
import asyncio
import hashlib
import ipaddress
import json
import os
import plistlib
import re
import secrets
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
from pydglab_ws import Channel, RetCode, StrengthOperationType, DGLabWSConnect, DGLabWSServer


def read_positive_int_env(name, default_value):
    """读取正整数环境变量；写错时使用默认值，避免证书策略配置错误导致服务无法启动"""
    try:
        value = int(os.environ.get(name, str(default_value)))
    except (TypeError, ValueError):
        return default_value
    return value if value > 0 else default_value


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
# 如现场网络必须固定某个地址，可通过 DG_LAB_CERT_IP 覆盖自动检测结果。
CERT_IP_OVERRIDE = os.environ.get("DG_LAB_CERT_IP", "").strip()
CERTIFIED_LAN_IP = CERT_IP_OVERRIDE
ROOT_CA_VALID_DAYS = read_positive_int_env("DG_LAB_ROOT_CA_DAYS", 90)
SERVER_CERT_VALID_DAYS = read_positive_int_env("DG_LAB_SERVER_CERT_DAYS", 7)
CERT_DIR = PROJECT_ROOT / "certs"
CERT_PRIVATE_DIR = CERT_DIR / "private"
ROOT_CA_PEM = CERT_DIR / "dg-lab-root-ca.pem"
ROOT_CA_CER = CERT_DIR / "dg-lab-root-ca.cer"
ROOT_CA_MOBILECONFIG = CERT_DIR / "dg-lab-root-ca.mobileconfig"
ROOT_CA_KEY = CERT_PRIVATE_DIR / "dg-lab-root-ca-key.pem"
SERVER_CERT_PEM = CERT_DIR / "dg-lab-server.pem"
SERVER_CERT_KEY = CERT_PRIVATE_DIR / "dg-lab-server-key.pem"
SERVER_CERT_CSR = CERT_PRIVATE_DIR / "dg-lab-server.csr"
SERVER_CERT_CONFIG = CERT_PRIVATE_DIR / "dg-lab-server-openssl.cnf"
CERT_IP_MARKER = CERT_DIR / "dg-lab-cert-ip.txt"
CERT_POLICY_MARKER = CERT_DIR / "dg-lab-cert-policy.json"
ROOT_CA_CER_URL_PATH = "/certs/dg-lab-root-ca.cer"
ROOT_CA_MOBILECONFIG_URL_PATH = "/certs/dg-lab-root-ca.mobileconfig"
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
TEST_MAX_STRENGTH = 30
TEST_MAX_DURATION_MS = 1000
TEST_COOLDOWN_SECONDS = 1.5

# 服务运行实例句柄 (用于端口热重启)
http_server_instance = None
https_server_instance = None
web_ws_server_instance = None
secure_web_ws_server_instance = None
http_server_ready = threading.Event()
https_server_ready = threading.Event()

# app_client 缓存
dg_app_client = None

# 系统连接状态
state = {
    "app_connected": False,      # 手机官方 App 是否已绑定
    "app_latency": -1,           # 电脑到手机 App 的网速延迟 (ms)
    "game_latency": -1,          # 电脑到手机浏览器小游戏页的应用层延迟 (ms)
    "app_qrcode_url": "",        # 手机 App 绑定扫码 URL
    "client_strength_a": 0,      # A 通道当前实际强度
    "client_strength_b": 0,      # B 通道当前实际强度
    # None 表示 App 还没有回传限幅。未知限幅不能按 200 处理，否则刚绑定时可能越过用户在 App 内设定的安全上限。
    "limit_a": None,             # A 通道硬件上限限制
    "limit_b": None,             # B 通道硬件上限限制
    "battery_level": None,       # V3 文档有电量特征位；当前 pydglab-ws 桥接层未暴露读取接口
    "game_client_connected": False # 手机小游戏网页是否已连入
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


# --- 工具函数：网络与端口探测 ---

def get_local_ip():
    """获取手机能访问的本地局域网 IPv4 地址，避开 VPN/虚拟网卡地址"""

    def is_usable_lan_ip(ip_text):
        try:
            ip = ipaddress.ip_address(ip_text)
        except ValueError:
            return False

        if ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_unspecified:
            return False

        # 198.18.0.0/15 常见于代理/VPN/测试网段，手机通常无法通过它访问电脑。
        if ip in ipaddress.ip_network("198.18.0.0/15"):
            return False

        return ip.version == 4 and ip.is_private

    candidates = []

    # macOS 下 ifconfig 能看到真实 Wi-Fi 地址；优先从这里找 RFC1918 私有网段地址。
    try:
        output = subprocess.check_output(["/sbin/ifconfig"], text=True, timeout=2)
        for match in re.finditer(r"\binet (\d+\.\d+\.\d+\.\d+)\b", output):
            ip_text = match.group(1)
            if is_usable_lan_ip(ip_text):
                candidates.append(ip_text)
    except Exception:
        pass

    # 兜底：再尝试系统主机名解析，避免非 macOS 环境没有 ifconfig。
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip_text = info[4][0]
            if is_usable_lan_ip(ip_text):
                candidates.append(ip_text)
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
        ip = s.getsockname()[0]
    except Exception:
        ip = "127.0.0.1"
    finally:
        s.close()
    return ip


def find_free_port(start_port):
    """自动寻找可用的空闲端口，防止冲突"""
    port = start_port
    while True:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("0.0.0.0", port))
                return port
            except socket.error:
                port += 1


def run_openssl(args):
    """执行本地 openssl 命令；失败时抛出带原因的异常，方便启动日志定位"""
    result = subprocess.run(
        ["openssl", *args],
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

    result = subprocess.run(
        ["openssl", "x509", "-in", str(cert_path), "-noout", "-enddate"],
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
                "PayloadCertificateFileName": "dg-lab-root-ca.cer",
                "PayloadContent": root_der,
                "PayloadDescription": "DG-LAB 本地 HTTPS 根证书，仅用于信任本机局域网小游戏服务。",
                "PayloadDisplayName": "DG-LAB Local Root CA",
                "PayloadIdentifier": "local.dg-lab.root-ca",
                "PayloadType": "com.apple.security.root",
                "PayloadUUID": str(uuid.uuid4()).upper(),
                "PayloadVersion": 1
            }
        ],
        "PayloadDescription": "安装后需在 设置 > 通用 > 关于本机 > 证书信任设置 中手动开启完全信任。",
        "PayloadDisplayName": "DG-LAB 本地 HTTPS 根证书",
        "PayloadIdentifier": "local.dg-lab.profile",
        "PayloadOrganization": "DG-LAB Local",
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
        "/CN=DG-LAB Local Root CA"
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

    if shutil.which("openssl") is None:
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


def run_http_server():
    """多线程托管 HTTP 服务"""
    global http_server_instance, HTTP_PORT
    HTTP_PORT = find_free_port(HTTP_PORT)
    
    server_address = ("", HTTP_PORT)
    http_server_instance = ThreadingHTTPServer(server_address, StaticHTTPRequestHandler)
    
    # 打印冷峻格式启动日志
    print(f"HTTP 服务已启动: 端口 {HTTP_PORT}")
    http_server_ready.set()
    http_server_instance.serve_forever()


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
        https_server_instance = ThreadingHTTPServer(server_address, StaticHTTPRequestHandler)
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
        https_server_ready.set()


# --- 2. WebSocket 广播函数 ---

async def broadcast_state():
    """向控制台和手机游戏页同步当前的最新连接状态、端口与硬件读数"""
    async with state_lock:
        msg = {
            "type": "state_update",
            "local_ip": LOCAL_IP,
            "http_port": HTTP_PORT,
            "web_ws_port": WEB_WS_PORT,
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
            "app_ws_port": APP_WS_PORT,
            "game_token": GAME_ACCESS_TOKEN,
            "app_connected": state["app_connected"],
            "app_latency": state["app_latency"],
            "game_latency": state["game_latency"],
            "app_qrcode_url": state["app_qrcode_url"],
            "strength_a": state["client_strength_a"],
            "strength_b": state["client_strength_b"],
            "limit_a": state["limit_a"],
            "limit_b": state["limit_b"],
            "battery_level": state["battery_level"],
            "game_connected": state["game_client_connected"]
        }
    payload = json.dumps(msg)
    targets = tuple(console_connections | game_connections)
    if targets:
        await asyncio.gather(*(c.send(payload) for c in targets), return_exceptions=True)


# --- 3. 官方 App 桥接后台协程 (基于 pydglab-ws) ---

async def monitor_app_latency(client):
    """周期性测量电脑到手机 App 的标准 RFC 6455 Ping/Pong 延迟"""
    global state
    while True:
        if state["app_connected"] and client.websocket:
            try:
                start_time = asyncio.get_event_loop().time()
                # 发送底层的 Ping 控制帧并等待 Pong 回复
                pong_waiter = await client.websocket.ping()
                await asyncio.wait_for(pong_waiter, timeout=2.0)
                rtt = int((asyncio.get_event_loop().time() - start_time) * 1000)
                state["app_latency"] = rtt
            except Exception:
                state["app_latency"] = -1
            await broadcast_state()
        await asyncio.sleep(2)


def update_hardware_state_from_data(data):
    """兼容 pydglab-ws 当前与可能的旧字段名，并把硬件回读压入协议允许范围"""
    if hasattr(data, "a") and hasattr(data, "b"):
        state["client_strength_a"] = clamp_int(getattr(data, "a"), 0, 200, fallback=0)
        state["client_strength_b"] = clamp_int(getattr(data, "b"), 0, 200, fallback=0)

    # pydglab-ws 1.1.0 的真实字段是 a_limit / b_limit。旧代码误读成 limit_a / limit_b，
    # 导致页面一直显示 0，后端又错误地把 0 当成 200 使用，实际绕开了 App 内的限幅设置。
    limit_a = getattr(data, "a_limit", None)
    limit_b = getattr(data, "b_limit", None)
    if limit_a is None:
        limit_a = getattr(data, "limit_a", None)
    if limit_b is None:
        limit_b = getattr(data, "limit_b", None)
    if limit_a is not None:
        state["limit_a"] = clamp_int(limit_a, 0, 200, fallback=0)
    if limit_b is not None:
        state["limit_b"] = clamp_int(limit_b, 0, 200, fallback=0)

    # 当前 1.1.0 尚未公开电量字段；保留兼容读取，未来升级依赖后无需修改页面协议。
    battery_value = getattr(data, "battery_level", None)
    if battery_value is None:
        battery_value = getattr(data, "battery", None)
    if battery_value is not None:
        state["battery_level"] = clamp_int(battery_value, 0, 100, fallback=0)


async def read_app_data_stream(client):
    """持续读取 App 回传的硬件状态更新数据流"""
    global state
    try:
        async for data in client.data_generator():
            if data == RetCode.CLIENT_DISCONNECTED:
                print("手机 App 已断开绑定")
                state["app_connected"] = False
                state["app_latency"] = -1
                state["client_strength_a"] = 0
                state["client_strength_b"] = 0
                state["limit_a"] = None
                state["limit_b"] = None
                state["battery_level"] = None
                await broadcast_state()
                return

            # 一旦收到数据包，说明 App 已扫码连接并成功绑定
            if not state["app_connected"]:
                state["app_connected"] = True
                print("手机 App 绑定已建立")
            
            # data_generator 可能回传强度数据、物理按键或心跳；只有存在对应字段时才更新硬件读数。
            update_hardware_state_from_data(data)
                
            # 若是收到设备端按钮被按下的通知，向控制台和游戏广播
            if hasattr(data, 'name'):
                btn_msg = json.dumps({"type": "button_feedback", "button": data.name})
                if console_connections:
                    await asyncio.gather(*(c.send(btn_msg) for c in console_connections), return_exceptions=True)
                if game_connections:
                    await asyncio.gather(*(g.send(btn_msg) for g in game_connections), return_exceptions=True)

            await broadcast_state()
    except Exception as e:
        print(f"与 App 的连接断开: {e}")
        state["app_connected"] = False
        state["app_latency"] = -1
        state["client_strength_a"] = 0
        state["client_strength_b"] = 0
        state["limit_a"] = None
        state["limit_b"] = None
        state["battery_level"] = None
        await broadcast_state()


async def app_bridge_runner():
    """异步长久运行 App 服务端和控制客户端，断线后自动重建绑定入口"""
    global dg_app_client, state, APP_WS_PORT

    while True:
        APP_WS_PORT = find_free_port(APP_WS_PORT)

        try:
            # 启动远控网关，并在 App 掉线后退出上下文释放端口，下一轮重新生成二维码。
            async with DGLabWSServer("0.0.0.0", APP_WS_PORT) as server:
                print(f"App 远控网关已启动: 端口 {APP_WS_PORT}")

                async with DGLabWSConnect(f"ws://127.0.0.1:{APP_WS_PORT}") as client:
                    dg_app_client = client
                    state["app_qrcode_url"] = client.get_qrcode(f"ws://{LOCAL_IP}:{APP_WS_PORT}")
                    await broadcast_state()

                    read_task = asyncio.create_task(read_app_data_stream(client))
                    latency_task = asyncio.create_task(monitor_app_latency(client))
                    done, pending = await asyncio.wait(
                        {read_task, latency_task},
                        return_when=asyncio.FIRST_COMPLETED
                    )

                    for task in pending:
                        task.cancel()
                    await asyncio.gather(*pending, return_exceptions=True)
                    for task in done:
                        task.result()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            print(f"App 桥接运行异常: {e}")
        finally:
            state["app_connected"] = False
            state["app_latency"] = -1
            state["client_strength_a"] = 0
            state["client_strength_b"] = 0
            state["limit_a"] = None
            state["limit_b"] = None
            state["battery_level"] = None
            dg_app_client = None
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


def build_pulse_operation(channel_strength):
    """构造 pydglab-ws 需要的 V3 单组 100ms 波形数据"""
    # pydglab-ws 的 PulseOperation 是 ((4 个频率值), (4 个波形强度值))，
    # 不是旧代码里误写的 4 元组。波形强度上限是 100，通道强度上限是 200。
    wave_strength = clamp_int(round(channel_strength / 2), 1, 100, fallback=1)
    return ((100, 100, 100, 100), (wave_strength, wave_strength, wave_strength, wave_strength))


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
    """在持有 shock_lock 时逐路清空；单路失败也必须继续尝试停止另一通道"""
    state["client_strength_a"] = 0
    state["client_strength_b"] = 0
    if not dg_app_client or not state["app_connected"]:
        return

    errors = []
    for channel in (Channel.A, Channel.B):
        try:
            await dg_app_client.clear_pulses(channel)
            await dg_app_client.set_strength(channel, StrengthOperationType.SET_TO, 0)
        except Exception as error:
            errors.append(f"{channel}: {error}")
    if errors:
        print(f"停止输出未全部成功: {'; '.join(errors)}")


def on_output_task_done(task):
    """释放当前任务引用；任务内部已记录异常，这里只处理正常取消"""
    global active_output_task
    if active_output_task is task:
        active_output_task = None


def schedule_game_shock(
    strength,
    duration_ms,
    output_mode="a",
    b_strength_mode="percent",
    b_strength_percent=50,
    clear_after=True
):
    """最多保留一个硬件输出任务，防止异常页面把 60 秒任务无限堆进内存"""
    global active_output_task
    if not state["app_connected"] or not dg_app_client:
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
    active_output_task.add_done_callback(on_output_task_done)
    return True


async def stop_all_output():
    """立即取消当前任务并串行清空 A/B 两路，避免停止命令与脉冲下发交叉执行"""
    global shock_generation, active_output_task
    shock_generation += 1

    running_task = active_output_task
    current_task = asyncio.current_task()
    if running_task and running_task is not current_task and not running_task.done():
        running_task.cancel()
        await asyncio.gather(running_task, return_exceptions=True)
        if active_output_task is running_task:
            active_output_task = None

    async with shock_lock:
        await clear_all_output_locked()


async def handle_game_shock(
    strength,
    duration_ms,
    output_mode="a",
    b_strength_mode="percent",
    b_strength_percent=50,
    clear_after=True
):
    """向 App 客户端下发一段受限脉冲；所有硬件写入都在同一把锁内串行执行"""
    global dg_app_client, state, shock_generation
    if not state["app_connected"] or not dg_app_client:
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

        loops = max(1, int(safe_duration / 100))
        generation = shock_generation

        async with shock_lock:
            if not state["app_connected"] or generation != shock_generation:
                return

            pulse_targets = []
            for channel, safe_strength, state_key in channel_targets:
                await dg_app_client.set_strength(channel, StrengthOperationType.SET_TO, safe_strength)
                state[state_key] = safe_strength
                pulse_targets.append((channel, build_pulse_operation(safe_strength)))

            for _ in range(loops):
                if not state["app_connected"] or generation != shock_generation:
                    break
                for channel, pulse_unit in pulse_targets:
                    await dg_app_client.add_pulses(channel, pulse_unit)
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


async def handle_test_shock_request(websocket, data):
    """处理连接测试的低强度试电请求；后端强制限幅，不能被前端参数绕过"""
    global last_test_shock_at

    now = asyncio.get_running_loop().time()
    remaining = TEST_COOLDOWN_SECONDS - (now - last_test_shock_at)
    if remaining > 0:
        await send_test_feedback(websocket, False, f"测试冷却中，约 {remaining:.1f}s 后再试")
        return

    if not state["app_connected"] or not dg_app_client:
        await send_test_feedback(websocket, False, "官方 App 未绑定，无法试电")
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
                    await stop_all_output()
                    await send_test_feedback(websocket, True, "已请求停止 A/B 输出")
                    
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
                    last_pulse_at = game_connection_last_pulse_at.get(websocket, 0)
                    if now - last_pulse_at < MIN_PULSE_INTERVAL_SECONDS:
                        continue
                    game_connection_last_pulse_at[websocket] = now

                    strength = clamp_int(data.get("strength", 0), 0, 200, fallback=0)
                    duration = clamp_int(data.get("duration", 120), 100, 500, fallback=120)
                    if strength > 0:
                        output_mode, b_strength_mode, b_strength_percent = parse_output_config(data)
                        schedule_game_shock(
                            strength,
                            duration,
                            output_mode,
                            b_strength_mode,
                            b_strength_percent,
                            clear_after=False
                        )
                        
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
                        schedule_game_shock(
                            strength,
                            duration,
                            output_mode,
                            b_strength_mode,
                            b_strength_percent,
                            clear_after=True
                        )

                elif data.get("type") == "stop_shock":
                    await stop_all_output()
                        
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            game_connections.discard(websocket)
            game_connection_last_pulse_at.pop(websocket, None)
            state["game_client_connected"] = len(game_connections) > 0
            if not state["game_client_connected"]:
                state["game_latency"] = -1
            await stop_all_output()
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


# --- 5. 系统初始化主协程 ---

async def main():
    global LOCAL_IP, CERTIFIED_LAN_IP
    LOCAL_IP = get_local_ip()
    CERTIFIED_LAN_IP = CERT_IP_OVERRIDE or LOCAL_IP
    
    print("=" * 45)
    print("DG-LAB 郊狼小游戏选择器中转系统 - 控制台")
    print(f"本地局域网 IP 地址: {LOCAL_IP}")
    print(f"HTTPS 证书签发 IP: {CERTIFIED_LAN_IP} ({'手动指定' if CERT_IP_OVERRIDE else '自动检测'})")
    print("=" * 45)

    # 1. 启动 HTTP 托管线程
    http_thread = threading.Thread(target=run_http_server, daemon=True)
    http_thread.start()
    await asyncio.get_running_loop().run_in_executor(None, http_server_ready.wait)

    # 2. 启动 HTTPS 托管线程。iPhone 传感器权限依赖安全页面，失败时不影响普通 HTTP 玩法。
    https_thread = threading.Thread(target=run_https_server, daemon=True)
    https_thread.start()
    await asyncio.get_running_loop().run_in_executor(None, https_server_ready.wait)

    # 3. 启动网页 WebSocket 交互服务
    await run_web_ws_server()
    await run_secure_web_ws_server()

    # 4. 后台启动官方 App 远控网关及绑定桥接
    asyncio.create_task(app_bridge_runner())

    # 5. 运行环境就绪后，在电脑端自动打开浏览器控制台
    print("服务已启动")
    webbrowser.open(f"http://127.0.0.1:{HTTP_PORT}/static/index.html?ws={WEB_WS_PORT}")
    if HTTPS_ENABLED:
        print(f"手机证书安装页: http://{LOCAL_IP}:{HTTP_PORT}/static/index.html?ws={WEB_WS_PORT}")
        print(f"手机 HTTPS 游戏页: https://{CERTIFIED_LAN_IP}:{HTTPS_PORT}/static/game.html?ws={SECURE_WEB_WS_PORT}&token={GAME_ACCESS_TOKEN}")

    # 6. 挂起主协程，保持服务持久运行
    await asyncio.Event().wait()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n服务已退出")
