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
CERT_DIR = Path("certs")
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
CERT_SHA256 = ""
CERT_ROOT_NOT_AFTER = ""
CERT_SERVER_NOT_AFTER = ""
HTTPS_ENABLED = False

# 游戏端惩罚的硬边界。前端也会限流，但后端必须自己兜底，不能相信局域网客户端。
MIN_SHOCK_DURATION_MS = 100
MAX_SHOCK_DURATION_MS = 60000
MIN_PULSE_INTERVAL_SECONDS = 0.22
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
    "limit_a": 0,                # A 通道硬件上限限制
    "limit_b": 0,                # B 通道硬件上限限制
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

class StaticHTTPRequestHandler(SimpleHTTPRequestHandler):
    """静默静态文件处理器；允许下载公开证书，禁止访问任何私钥"""

    CERT_MIME_TYPES = {
        ".cer": "application/pkix-cert",
        ".mobileconfig": "application/x-apple-aspen-config",
        ".pem": "application/x-pem-file"
    }

    def is_forbidden_path(self):
        request_path = unquote(urlparse(self.path).path).lstrip("/")
        normalized = Path(request_path)
        parts = normalized.parts
        if len(parts) >= 2 and parts[0] == "certs" and parts[1] == "private":
            return True
        if normalized.name.endswith("-key.pem"):
            return True
        if normalized.name.endswith(".csr") or normalized.name.endswith(".srl"):
            return True
        return False

    def do_GET(self):
        if self.is_forbidden_path():
            self.send_error(403, "private certificate material is not downloadable")
            return
        super().do_GET()

    def do_HEAD(self):
        if self.is_forbidden_path():
            self.send_error(403, "private certificate material is not downloadable")
            return
        super().do_HEAD()

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
            "cert_profile_path": f"/{ROOT_CA_MOBILECONFIG.as_posix()}",
            "cert_cer_path": f"/{ROOT_CA_CER.as_posix()}",
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
                state["battery_level"] = None
                await broadcast_state()
                return

            # 一旦收到数据包，说明 App 已扫码连接并成功绑定
            if not state["app_connected"]:
                state["app_connected"] = True
                print("手机 App 绑定已建立")
            
            # 解析强度与硬件硬上限设置
            # 因为 data_generator 回传的可能是 StrengthData 或 FeedbackButton
            if hasattr(data, 'a') and hasattr(data, 'b'):
                state["client_strength_a"] = data.a
                state["client_strength_b"] = data.b
            if hasattr(data, 'limit_a') and hasattr(data, 'limit_b'):
                state["limit_a"] = data.limit_a
                state["limit_b"] = data.limit_b
            # 当前 pydglab-ws 1.1.0 没有公开电量数据类型；这里兼容后续版本可能新增的字段。
            battery_value = getattr(data, 'battery_level', None)
            if battery_value is None:
                battery_value = getattr(data, 'battery', None)
            if battery_value is not None:
                try:
                    state["battery_level"] = max(0, min(100, int(battery_value)))
                except (TypeError, ValueError):
                    pass
                
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
            state["battery_level"] = None
            dg_app_client = None
            await broadcast_state()

        await asyncio.sleep(1)


# --- 4. 网页端控制台与手机小游戏 WebSocket 服务 (8081端口) ---

def clamp_int(value, minimum, maximum, fallback=0):
    """把外部输入压成安全整数，防止字符串、空值、超大值直接进入硬件控制逻辑"""
    try:
        number = int(value)
    except (TypeError, ValueError):
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

    limit_a = state["limit_a"] if state["limit_a"] > 0 else 200
    limit_b = state["limit_b"] if state["limit_b"] > 0 else 200
    targets = []

    if output_mode in {"a", "ab"}:
        targets.append((Channel.A, min(base, limit_a), "client_strength_a"))

    if output_mode in {"b", "ab"}:
        b_base = base if b_strength_mode == "same" else round(base * b_strength_percent / 100)
        targets.append((Channel.B, min(clamp_int(b_base, 0, 200, fallback=0), limit_b), "client_strength_b"))

    return [(channel, strength, state_key) for channel, strength, state_key in targets if strength > 0]


async def stop_all_output():
    """尽量清空 A/B 两路输出，用于返回列表、断线或用户点击停止输出"""
    global dg_app_client, shock_generation
    shock_generation += 1
    if not dg_app_client or not state["app_connected"]:
        return

    try:
        for channel in (Channel.A, Channel.B):
            await dg_app_client.clear_pulses(channel)
            await dg_app_client.set_strength(channel, StrengthOperationType.SET_TO, 0)
        state["client_strength_a"] = 0
        state["client_strength_b"] = 0
    except Exception as e:
        print(f"停止输出失败: {e}")


async def handle_game_shock(
    strength,
    duration_ms,
    output_mode="a",
    b_strength_mode="percent",
    b_strength_percent=50,
    clear_after=True
):
    """向 App 客户端下发电击脉冲任务的公共逻辑"""
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

            # 结算型惩罚结束后主动清空，避免设备端队列里残留后续波形；持续型脉冲由下一帧覆盖。
            if clear_after:
                await stop_all_output()
    except Exception as e:
        print(f"脉冲下发失败: {e}")


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
    last_test_shock_at = now

    asyncio.create_task(handle_game_shock(
        strength,
        duration,
        output_mode,
        b_strength_mode,
        b_strength_percent,
        clear_after=True
    ))
    await send_test_feedback(websocket, True, f"已发送安全试电：{strength} 强度，{duration / 1000:.1f}s")


async def web_ws_handler(websocket, path):
    """处理来自电脑控制台网页 (/console) 与手机小游戏网页 (/game) 的连接"""
    global state

    parsed_path = urlparse(path or "/")
    route = parsed_path.path

    if route == "/console":
        console_connections.add(websocket)
        # 连入后立即同步一次最新状态
        await broadcast_state()
        try:
            async for message in websocket:
                try:
                    data = json.loads(message)
                except json.JSONDecodeError:
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
        if token != GAME_ACCESS_TOKEN:
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
                        asyncio.create_task(handle_game_shock(
                            strength,
                            duration,
                            output_mode,
                            b_strength_mode,
                            b_strength_percent,
                            clear_after=False
                        ))
                        
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
                        # 开启一个后台异步任务执行指定时长的电击
                        asyncio.create_task(handle_game_shock(
                            strength,
                            duration,
                            output_mode,
                            b_strength_mode,
                            b_strength_percent,
                            clear_after=True
                        ))

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
    
    server = await websockets.serve(web_ws_handler, "0.0.0.0", WEB_WS_PORT)
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
        ssl=ssl_context
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
