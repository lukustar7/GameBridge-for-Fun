# -*- coding: utf-8 -*-
"""后端安全边界、硬件限幅与输出调度的回归测试。"""

import asyncio
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

# 后端源码位于 server/ 子目录，测试导入前需要加入模块搜索路径。
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

import server


class FakeWebSocket:
    """只提供控制台鉴权所需字段，避免测试依赖真实浏览器连接。"""

    def __init__(self, remote_host, origin):
        self.remote_address = (remote_host, 12345)
        self.request_headers = {"Origin": origin} if origin is not None else {}


class FakeDeviceAppClient:
    """记录硬件调用顺序，不连接真实设备 App 或硬件。"""

    def __init__(self, fail_clear_channel=None, hang_clear_channel=None, clear_delay=0):
        self.events = []
        self.fail_clear_channel = fail_clear_channel
        self.hang_clear_channel = hang_clear_channel
        self.clear_delay = clear_delay

    async def set_temporary_strength(self, channel, value, duration_ms):
        self.events.append(("set_temporary_strength", channel, value, duration_ms))

    async def send_pulse(self, channel, strength, waveform_key, duration_ms=100):
        self.events.append(("send_pulse", channel, strength, waveform_key, duration_ms))

    async def clear_pulses(self, channel):
        self.events.append(("clear_pulses", channel))
        if self.clear_delay:
            await asyncio.sleep(self.clear_delay)
        if channel == self.hang_clear_channel:
            await asyncio.Event().wait()
        if channel == self.fail_clear_channel:
            raise RuntimeError("模拟单通道停止失败")

    async def reset_strength(self, channel):
        self.events.append(("reset_strength", channel))


class ScriptedGameWebSocket:
    """按预定时间向真实游戏处理器送消息，并记录服务端反馈。"""

    def __init__(self, script):
        # 每一项由“等待秒数 + 消息内容”组成；短暂停顿让后台输出任务真实获得执行机会。
        self.script = iter(script)
        self.sent_messages = []
        self.closed = False
        self.close_code = None
        self.close_reason = None

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            delay_seconds, payload = next(self.script)
        except StopIteration as error:
            raise StopAsyncIteration from error
        if delay_seconds:
            await asyncio.sleep(delay_seconds)
        return payload if isinstance(payload, str) else server.json.dumps(payload)

    async def send(self, message):
        """保存状态广播和操作反馈，效果等同于浏览器收到了 WebSocket 消息。"""
        self.sent_messages.append(server.json.loads(message))

    async def close(self, code=1000, reason=""):
        """记录鉴权拒绝，便于确认无令牌页面没有进入硬件控制流程。"""
        self.closed = True
        self.close_code = code
        self.close_reason = reason


class ServerLogicTests(unittest.TestCase):
    """验证不需要启动网络服务的纯逻辑。"""

    def setUp(self):
        self.original_state = server.state.copy()
        self.original_http_port = server.HTTP_PORT
        self.original_https_port = server.HTTPS_PORT
        self.original_https_enabled = server.HTTPS_ENABLED

    def tearDown(self):
        server.state.clear()
        server.state.update(self.original_state)
        server.HTTP_PORT = self.original_http_port
        server.HTTPS_PORT = self.original_https_port
        server.HTTPS_ENABLED = self.original_https_enabled

    def test_unknown_limits_disable_output(self):
        """App 尚未回传限幅时不能擅自按协议最大值 200 输出。"""
        server.state["limit_a"] = None
        server.state["limit_b"] = None

        targets = server.build_channel_strengths(100, "ab")

        self.assertEqual(targets, [])

    def test_dual_channel_requires_both_limits(self):
        """A+B 是一个整体选择，缺少 B 限幅时不能悄悄退化成只输出 A。"""
        server.state["limit_a"] = 80
        server.state["limit_b"] = None

        targets = server.build_channel_strengths(30, "ab")

        self.assertEqual(targets, [])

    def test_non_finite_numbers_fall_back_without_crashing(self):
        """JSON 可解析出 Infinity/NaN；这些值不能让整数转换抛异常并断开连接。"""
        self.assertEqual(server.clamp_int(float("inf"), 0, 200, fallback=7), 7)
        self.assertEqual(server.clamp_int(float("nan"), 0, 200, fallback=9), 9)
        self.assertIsNone(server.parse_finite_float(float("inf")))
        self.assertIsNone(server.parse_finite_float(float("nan")))
        self.assertIsNone(server.parse_finite_float("not-a-number"))
        self.assertEqual(server.parse_finite_float("59.5"), 59.5)

    def test_non_ascii_game_token_is_rejected_without_exception(self):
        """恶意查询参数可能包含中文；校验应稳定返回失败，而不是抛出字符串比较异常。"""
        self.assertFalse(server.is_valid_game_token("无效令牌"))
        self.assertTrue(server.is_valid_game_token(server.GAME_ACCESS_TOKEN))

    def test_strengths_are_clamped_per_channel(self):
        """A/B 两路分别受自己的 App 限幅控制。"""
        server.state["limit_a"] = 40
        server.state["limit_b"] = 30

        targets = server.build_channel_strengths(100, "ab")

        self.assertEqual(
            targets,
            [
                (server.Channel.A, 40, "client_strength_a"),
                (server.Channel.B, 30, "client_strength_b"),
            ],
        )

    def test_unknown_waveform_request_uses_immediate_default(self):
        """局域网页面伪造波形名称时不能进入未知硬件分支。"""

        self.assertEqual(
            server.parse_waveform_config({"waveform": "not-supported"}),
            server.DEFAULT_WAVEFORM_KEY,
        )

    def test_console_requires_loopback_peer_and_matching_local_origin(self):
        """只有本机、且由当前控制台端口打开的网页可以读取控制台状态。"""
        server.HTTP_PORT = 18080
        server.HTTPS_ENABLED = False

        allowed = FakeWebSocket("127.0.0.1", "http://127.0.0.1:18080")
        lan_peer = FakeWebSocket("192.168.1.50", "http://127.0.0.1:18080")
        foreign_origin = FakeWebSocket("127.0.0.1", "https://example.com")
        wrong_port = FakeWebSocket("127.0.0.1", "http://localhost:19000")

        self.assertTrue(server.is_console_request_authorized(allowed))
        self.assertFalse(server.is_console_request_authorized(lan_peer))
        self.assertFalse(server.is_console_request_authorized(foreign_origin))
        self.assertFalse(server.is_console_request_authorized(wrong_port))

    def test_certificate_override_only_accepts_canonical_private_ipv4(self):
        """证书环境变量会进入 OpenSSL 配置，只能接受规范的 RFC1918 IPv4。"""
        self.assertEqual(server.normalize_private_ipv4("192.168.1.20"), "192.168.1.20")
        self.assertEqual(server.normalize_private_ipv4("172.31.255.254"), "172.31.255.254")
        self.assertEqual(server.normalize_private_ipv4("8.8.8.8"), "")
        self.assertEqual(server.normalize_private_ipv4("127.0.0.1"), "")
        self.assertEqual(server.normalize_private_ipv4("192.168.1.20\nDNS.2 = example.com"), "")

    def test_local_ip_prefers_macos_default_route(self):
        """默认路由网卡必须排在 VPN 和虚拟网卡之前，保证手机二维码使用真实局域网地址。"""
        route_result = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout="   route to: default\ninterface: en0\n",
            stderr="",
        )
        address_result = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout="192.168.50.23\n",
            stderr="",
        )
        ifconfig_output = (
            "en1: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST>\n"
            "\tinet 10.0.0.5 netmask 0xff000000\n"
        )

        with patch(
            "server.subprocess.run",
            side_effect=(route_result, address_result),
        ), patch(
            "server.subprocess.check_output",
            return_value=ifconfig_output,
        ), patch.object(server, "CERT_IP_OVERRIDE", ""):
            self.assertEqual(server.get_local_ip(), "192.168.50.23")

    def test_local_ip_ignores_vpn_default_route(self):
        """VPN 成为默认路由时仍要选择物理网卡，避免手机拿到 utun 地址。"""
        route_result = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout="   route to: default\ninterface: utun4\n",
            stderr="",
        )
        ifconfig_output = (
            "utun4: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST>\n"
            "\tinet 10.8.0.2 --> 10.8.0.2 netmask 0xffffffff\n"
            "en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST>\n"
            "\tinet 192.168.31.45 netmask 0xffffff00 broadcast 192.168.31.255\n"
        )

        with patch("server.subprocess.run", return_value=route_result), patch(
            "server.subprocess.check_output",
            return_value=ifconfig_output,
        ), patch.object(server, "CERT_IP_OVERRIDE", ""):
            self.assertEqual(server.get_local_ip(), "192.168.31.45")

    def test_openssl_finder_uses_system_fallback(self):
        """用户 PATH 被精简时仍应发现 macOS 系统证书工具。"""
        def fake_is_file(path):
            return str(path) == "/usr/bin/openssl"

        with patch("server.shutil.which", return_value=None), patch(
            "server.Path.is_file",
            fake_is_file,
        ), patch("server.os.access", return_value=True):
            self.assertEqual(server.find_openssl_executable(), "/usr/bin/openssl")

    def test_certificate_storage_migrates_out_of_project_and_locks_permissions(self):
        """旧私钥应迁出源码目录，迁移后的证书与私钥目录只允许当前用户访问。"""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            legacy_dir = root / "project" / "certs"
            legacy_private_dir = legacy_dir / "private"
            legacy_private_dir.mkdir(parents=True)
            (legacy_private_dir / "gamebridge-for-fun-root-ca-key.pem").write_text(
                "local-test-key",
                encoding="utf-8",
            )

            app_support_dir = root / "Library" / "Application Support" / "GameBridge for Fun"
            cert_dir = app_support_dir / "certs"
            private_dir = cert_dir / "private"
            replacements = {
                "APP_SUPPORT_DIR": app_support_dir,
                "CERT_DIR": cert_dir,
                "LEGACY_CERT_DIR": legacy_dir,
                "CERT_PRIVATE_DIR": private_dir,
                "ROOT_CA_KEY": private_dir / "gamebridge-for-fun-root-ca-key.pem",
                "SERVER_CERT_KEY": private_dir / "gamebridge-for-fun-server-key.pem",
                "SERVER_CERT_CSR": private_dir / "gamebridge-for-fun-server.csr",
                "SERVER_CERT_CONFIG": private_dir / "gamebridge-for-fun-server-openssl.cnf",
                "ROOT_CA_PEM": cert_dir / "gamebridge-for-fun-root-ca.pem",
                "SERVER_CERT_PEM": cert_dir / "gamebridge-for-fun-server.pem",
            }

            with patch.multiple(server, **replacements):
                server.prepare_certificate_storage()

            self.assertFalse(legacy_dir.exists())
            self.assertEqual(
                (private_dir / "gamebridge-for-fun-root-ca-key.pem").read_text(encoding="utf-8"),
                "local-test-key",
            )
            self.assertEqual(stat.S_IMODE(cert_dir.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(private_dir.stat().st_mode), 0o700)

    def test_certificate_storage_rejects_symlink_directory(self):
        """证书目录不能借符号链接跳到网盘、共享目录或其他非预期位置。"""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            actual_dir = root / "shared-cert-storage"
            actual_dir.mkdir()
            app_support_link = root / "GameBridge for Fun"
            app_support_link.symlink_to(actual_dir, target_is_directory=True)

            with patch.object(server, "APP_SUPPORT_DIR", app_support_link), patch.object(
                server,
                "CERT_DIR",
                app_support_link / "certs",
            ), patch.object(
                server,
                "CERT_PRIVATE_DIR",
                app_support_link / "certs" / "private",
            ), patch.object(
                server,
                "LEGACY_CERT_DIR",
                root / "project" / "certs",
            ):
                with self.assertRaisesRegex(RuntimeError, "符号链接"):
                    server.prepare_certificate_storage()

    def test_port_search_rejects_invalid_start_instead_of_looping(self):
        """端口越界时要立即失败，不能从 65536 开始无限递增。"""
        for value in (0, 65536, "not-a-port"):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    server.find_free_port(value)

    def test_port_search_skips_active_listener(self):
        """已有进程监听端口时必须选择下一端口，不能与活跃服务共享流量。"""
        listener = server.socket.socket(server.socket.AF_INET, server.socket.SOCK_STREAM)
        listener.bind(("0.0.0.0", 0))
        listener.listen()
        occupied_port = listener.getsockname()[1]
        try:
            self.assertNotEqual(server.find_free_port(occupied_port), occupied_port)
        finally:
            listener.close()

    def test_game_state_does_not_include_console_pairing_secrets(self):
        """已配对游戏页只拿运行状态，不应收到设备 App 二维码或运行 token。"""
        server.state["app_qrcode_url"] = "ws://192.168.1.20:15678/private"
        server.state["selected_device_id"] = "internal-app:slot-a"
        server.state["compatible_devices"] = [{
            "selection_id": "internal-app:slot-a",
            "client_id": "internal-app",
            "slot_id": "slot-a",
            "name": "测试设备",
            "type": "COYOTE_020",
            "model": "郊狼 2.0",
            "connected": True,
            "selected": True,
        }]

        game_message = server.build_state_message(include_console_details=False)
        console_message = server.build_state_message(include_console_details=True)

        self.assertNotIn("game_token", game_message)
        self.assertNotIn("app_qrcode_url", game_message)
        self.assertNotIn("selected_device_id", game_message)
        self.assertNotIn("compatible_devices", game_message)
        self.assertEqual(console_message["game_token"], server.GAME_ACCESS_TOKEN)
        self.assertEqual(console_message["app_qrcode_url"], server.state["app_qrcode_url"])
        self.assertNotIn("client_id", console_message["compatible_devices"][0])
        self.assertNotIn("slot_id", console_message["compatible_devices"][0])
        self.assertEqual(game_message["app_version"], server.APP_VERSION)
        self.assertEqual(console_message["app_version"], server.APP_VERSION)


class StaticHTTPBoundaryTests(unittest.TestCase):
    """启动临时 HTTP 服务，验证局域网只能拿到明确公开的网页资源。"""

    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.StaticHTTPRequestHandler)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        host, port = cls.httpd.server_address
        cls.base_url = f"http://{host}:{port}"

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=2)

    def test_root_serves_console_with_security_headers(self):
        with urlopen(f"{self.base_url}/", timeout=2) as response:
            body = response.read().decode("utf-8")

        self.assertIn("GameBridge for Fun 控制台", body)
        self.assertIn("apk-qrcode", body)
        self.assertIn("device-select", body)
        self.assertTrue(response.geturl().endswith("/static/index.html"))
        self.assertEqual(response.headers["Referrer-Policy"], "no-referrer")
        self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(response.headers["X-Frame-Options"], "DENY")
        self.assertEqual(response.headers["Cross-Origin-Resource-Policy"], "same-origin")
        self.assertIn("camera=()", response.headers["Permissions-Policy"])
        self.assertIn("object-src 'none'", response.headers["Content-Security-Policy"])
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertNotIn("Python", response.headers["Server"])

    def test_only_game_document_may_request_geolocation(self):
        """定位权限只能由小游戏主文档申请，控制台和其他资源继续显式禁止。"""
        with urlopen(f"{self.base_url}/static/game.html", timeout=2) as game_response:
            game_policy = game_response.headers["Permissions-Policy"]
            game_response.read()
        with urlopen(f"{self.base_url}/static/index.html", timeout=2) as console_response:
            console_policy = console_response.headers["Permissions-Policy"]
            console_response.read()

        self.assertIn("geolocation=(self)", game_policy)
        self.assertIn("accelerometer=(self)", game_policy)
        self.assertIn("gyroscope=(self)", game_policy)
        self.assertIn("geolocation=()", console_policy)
        self.assertIn("accelerometer=()", console_policy)

    def test_project_and_private_files_are_not_public(self):
        blocked_paths = (
            "/server.py",
            "/.git/config",
            "/coyote/README.md",
            "/certs/private/gamebridge-for-fun-root-ca-key.pem",
            "/static/%2e%2e/server.py",
        )

        for path in blocked_paths:
            with self.subTest(path=path):
                with self.assertRaises(HTTPError) as context:
                    urlopen(f"{self.base_url}{path}", timeout=2)
                self.assertEqual(context.exception.code, 404)

    def test_public_certificate_route_can_serve_file_outside_project(self):
        """证书迁到应用数据目录后，公开路由仍只能读取明确列出的两个文件。"""
        with tempfile.TemporaryDirectory() as directory:
            certificate_path = Path(directory) / "local-root.cer"
            certificate_path.write_bytes(b"public-root-certificate")
            original_routes = server.StaticHTTPRequestHandler.PUBLIC_CERTIFICATE_ROUTES
            server.StaticHTTPRequestHandler.PUBLIC_CERTIFICATE_ROUTES = {
                server.ROOT_CA_CER_URL_PATH: certificate_path,
            }
            try:
                with urlopen(f"{self.base_url}{server.ROOT_CA_CER_URL_PATH}", timeout=2) as response:
                    self.assertEqual(response.read(), b"public-root-certificate")
            finally:
                server.StaticHTTPRequestHandler.PUBLIC_CERTIFICATE_ROUTES = original_routes

    def test_head_request_uses_same_public_boundary(self):
        request = Request(f"{self.base_url}/.git/HEAD", method="HEAD")

        with self.assertRaises(HTTPError) as context:
            urlopen(request, timeout=2)

        self.assertEqual(context.exception.code, 404)


class OutputSchedulerTests(unittest.IsolatedAsyncioTestCase):
    """验证物理输出只有一个活动任务，并且停止命令不会漏掉任一通道。"""

    async def asyncSetUp(self):
        self.original_state = server.state.copy()
        self.original_client = server.device_app_client
        self.original_task = server.active_output_task
        self.original_task_clear_after = server.active_output_clear_after
        self.original_generation = server.shock_generation
        self.original_watchdog_task = server.output_watchdog_task
        self.original_watchdog_owner = server.output_watchdog_owner
        self.original_watchdog_mode = server.output_watchdog_mode
        self.original_watchdog_generation = server.output_watchdog_generation
        self.original_shock_lock = server.shock_lock
        self.original_state_lock = server.state_lock

        server.state["app_connected"] = True
        server.state["device_connected"] = True
        server.state["limit_a"] = 100
        server.state["limit_b"] = 100
        server.state["client_strength_a"] = 0
        server.state["client_strength_b"] = 0
        server.active_output_task = None
        server.active_output_clear_after = True
        server.output_watchdog_task = None
        server.output_watchdog_owner = None
        server.output_watchdog_mode = None
        server.shock_lock = asyncio.Lock()
        server.state_lock = asyncio.Lock()
        server.device_app_client = FakeDeviceAppClient()

    async def asyncTearDown(self):
        await server.stop_all_output()
        server.state.clear()
        server.state.update(self.original_state)
        server.device_app_client = self.original_client
        server.active_output_task = self.original_task
        server.active_output_clear_after = self.original_task_clear_after
        server.shock_generation = self.original_generation
        server.output_watchdog_task = self.original_watchdog_task
        server.output_watchdog_owner = self.original_watchdog_owner
        server.output_watchdog_mode = self.original_watchdog_mode
        server.output_watchdog_generation = self.original_watchdog_generation
        server.shock_lock = self.original_shock_lock
        server.state_lock = self.original_state_lock

    async def test_overlapping_output_is_rejected_without_queueing(self):
        first = server.schedule_game_shock(20, 1000, "a", clear_after=True)
        second = server.schedule_game_shock(20, 1000, "a", clear_after=True)

        self.assertTrue(first)
        self.assertFalse(second)

        await asyncio.sleep(0)
        await server.stop_all_output()
        self.assertIsNone(server.active_output_task)
        self.assertEqual(server.state["client_strength_a"], 0)

    async def test_output_uses_expiring_v4_strength_before_pulse(self):
        """非零强度必须使用带期限的 V4 任务，并在波形下发前完成入队。"""
        fake_client = server.device_app_client

        scheduled = server.schedule_game_shock(20, 100, "a", clear_after=True)
        self.assertTrue(scheduled)
        running_task = server.active_output_task
        await running_task

        self.assertEqual(fake_client.events[0][0], "set_temporary_strength")
        self.assertEqual(fake_client.events[0][1:3], (server.Channel.A, 20))
        self.assertGreaterEqual(fake_client.events[0][3], 100 + server.OUTPUT_AUTO_RESET_MARGIN_MS)
        self.assertIn(
            ("send_pulse", server.Channel.A, 20, server.DEFAULT_WAVEFORM_KEY, 100),
            fake_client.events,
        )
        self.assertEqual(server.state["client_strength_a"], 0)

    async def test_safe_test_ignores_requested_waveform_and_uses_default(self):
        """试电参数由后端决定，伪造页面不能换成更尖锐的固定波形。"""

        websocket = ScriptedGameWebSocket([])
        original_last_test = server.last_test_shock_at
        server.last_test_shock_at = -1000
        try:
            with patch.object(server, "schedule_game_shock", return_value=True) as schedule:
                await server.handle_test_shock_request(websocket, {
                    "waveform": "shade",
                    "duration": 300,
                    "outputMode": "a",
                })
        finally:
            server.last_test_shock_at = original_last_test

        self.assertEqual(schedule.call_args.args[0], server.TEST_DEFAULT_STRENGTH)
        self.assertEqual(schedule.call_args.kwargs["waveform_key"], server.DEFAULT_WAVEFORM_KEY)
        self.assertIn("15 强度", websocket.sent_messages[-1]["message"])
        self.assertIn("游戏默认波形", websocket.sent_messages[-1]["message"])

    async def test_stop_continues_with_b_when_a_clear_fails(self):
        fake_client = FakeDeviceAppClient(fail_clear_channel=server.Channel.A)
        server.device_app_client = fake_client

        # 这里故意制造 A 通道失败；屏蔽预期日志，测试结果只关注 B 是否仍被清空。
        with patch("builtins.print"):
            await server.stop_all_output()

        cleared_channels = [event[1] for event in fake_client.events if event[0] == "clear_pulses"]
        self.assertEqual(cleared_channels, [server.Channel.A, server.Channel.B])
        self.assertIsNone(server.state["client_strength_a"])
        self.assertEqual(server.state["client_strength_b"], 0)
        server.device_app_client = FakeDeviceAppClient()

    async def test_stop_timeout_on_a_still_attempts_b(self):
        """A 通道命令永久不返回时，超时机制仍必须继续停止 B 通道。"""
        fake_client = FakeDeviceAppClient(hang_clear_channel=server.Channel.A)
        server.device_app_client = fake_client

        with patch.object(server, "HARDWARE_COMMAND_TIMEOUT_SECONDS", 0.01), patch("builtins.print"):
            stopped = await server.stop_all_output()

        cleared_channels = [event[1] for event in fake_client.events if event[0] == "clear_pulses"]
        self.assertFalse(stopped)
        self.assertEqual(cleared_channels, [server.Channel.A, server.Channel.B])
        self.assertIsNone(server.state["client_strength_a"])
        self.assertEqual(server.state["client_strength_b"], 0)
        server.device_app_client = FakeDeviceAppClient()

    async def test_simultaneous_page_disconnects_share_current_loop_lock(self):
        """多个网页同时离线时停止动作应安全串行，不能引用旧事件循环。"""
        fake_client = FakeDeviceAppClient(clear_delay=0.005)
        server.device_app_client = fake_client

        results = await asyncio.gather(server.stop_all_output(), server.stop_all_output())

        self.assertEqual(results, [True, True])
        cleared_channels = [event[1] for event in fake_client.events if event[0] == "clear_pulses"]
        self.assertEqual(cleared_channels, [
            server.Channel.A,
            server.Channel.B,
            server.Channel.A,
            server.Channel.B,
        ])

    async def test_watchdog_stops_long_output_without_page_heartbeat(self):
        """网页冻结但连接尚未正式断开时，长时任务也必须由后端主动取消并归零。"""
        fake_client = server.device_app_client
        owner = object()

        with patch.object(server, "OUTPUT_HEARTBEAT_TIMEOUT_SECONDS", 0.03), patch("builtins.print"):
            scheduled = server.schedule_game_shock(25, 1000, "a", clear_after=True)
            self.assertTrue(scheduled)
            server.arm_output_watchdog(owner)
            await asyncio.sleep(0.08)

        cleared_channels = [event[1] for event in fake_client.events if event[0] == "clear_pulses"]
        self.assertEqual(cleared_channels, [server.Channel.A, server.Channel.B])
        self.assertEqual(server.state["client_strength_a"], 0)
        self.assertIsNone(server.active_output_task)
        self.assertIsNone(server.output_watchdog_task)

    async def test_page_heartbeat_only_extends_its_own_output_deadline(self):
        """所属页面可以续期，其他已配对页面不能替失联页面维持输出。"""
        fake_client = server.device_app_client
        owner = object()
        unrelated_page = object()

        with patch.object(server, "OUTPUT_HEARTBEAT_TIMEOUT_SECONDS", 0.05), patch("builtins.print"):
            scheduled = server.schedule_game_shock(25, 1000, "a", clear_after=True)
            self.assertTrue(scheduled)
            server.arm_output_watchdog(owner)
            await asyncio.sleep(0.03)
            server.refresh_output_watchdog(unrelated_page)
            await asyncio.sleep(0.03)

        cleared_channels = [event[1] for event in fake_client.events if event[0] == "clear_pulses"]
        self.assertEqual(cleared_channels, [server.Channel.A, server.Channel.B])
        self.assertEqual(server.state["client_strength_a"], 0)

    async def test_owner_heartbeat_postpones_watchdog_until_messages_stop(self):
        """正常页面每秒续报时不能误停；续报真正停止后仍要按新期限归零。"""
        fake_client = server.device_app_client
        owner = object()

        with patch.object(server, "OUTPUT_HEARTBEAT_TIMEOUT_SECONDS", 0.05), patch("builtins.print"):
            scheduled = server.schedule_game_shock(25, 1000, "a", clear_after=True)
            self.assertTrue(scheduled)
            server.arm_output_watchdog(owner)
            await asyncio.sleep(0.03)
            server.refresh_output_watchdog(owner)
            await asyncio.sleep(0.03)

            early_clears = [event for event in fake_client.events if event[0] == "clear_pulses"]
            self.assertEqual(early_clears, [])
            await asyncio.sleep(0.04)

        cleared_channels = [event[1] for event in fake_client.events if event[0] == "clear_pulses"]
        self.assertEqual(cleared_channels, [server.Channel.A, server.Channel.B])
        self.assertEqual(server.state["client_strength_a"], 0)

    async def test_page_ping_cannot_keep_continuous_pulse_strength_nonzero(self):
        """玩家回到安全区后只有普通 ping 时，短脉冲模式仍必须按空闲期限归零。"""
        fake_client = server.device_app_client
        owner = object()

        with patch.object(server, "CONTINUOUS_OUTPUT_IDLE_TIMEOUT_SECONDS", 0.05), patch("builtins.print"):
            scheduled = server.schedule_game_shock(25, 500, "a", clear_after=False)
            self.assertTrue(scheduled)
            server.arm_output_watchdog(owner, mode="continuous")
            await asyncio.sleep(0.03)
            server.refresh_output_watchdog(owner)
            await asyncio.sleep(0.04)

        cleared_channels = [event[1] for event in fake_client.events if event[0] == "clear_pulses"]
        self.assertEqual(cleared_channels, [server.Channel.A, server.Channel.B])
        self.assertEqual(server.state["client_strength_a"], 0)
        self.assertIsNone(server.output_watchdog_mode)


class FullGameDryRunTests(unittest.IsolatedAsyncioTestCase):
    """把五种游戏的真实 WebSocket 消息送进后端，用假设备核对整条安全链路。"""

    async def asyncSetUp(self):
        self.original_state = server.state.copy()
        self.original_client = server.device_app_client
        self.original_task = server.active_output_task
        self.original_task_clear_after = server.active_output_clear_after
        self.original_generation = server.shock_generation
        self.original_watchdog_task = server.output_watchdog_task
        self.original_watchdog_owner = server.output_watchdog_owner
        self.original_watchdog_mode = server.output_watchdog_mode
        self.original_watchdog_generation = server.output_watchdog_generation
        self.original_shock_lock = server.shock_lock
        self.original_state_lock = server.state_lock
        self.original_console_connections = set(server.console_connections)
        self.original_game_connections = set(server.game_connections)
        self.original_last_pulses = dict(server.game_connection_last_pulse_at)
        self.original_lightning_next = dict(server.game_connection_lightning_next_at)
        self.original_dice_rounds = dict(server.game_connection_dice_round)
        self.original_lightning_sessions = dict(server.game_connection_lightning_session)

        # 使用不对称上限能验证 A/B 分路限幅：即使网页恶意请求 999，也只能到 40/30。
        server.state["app_connected"] = True
        server.state["device_connected"] = True
        server.state["limit_a"] = 40
        server.state["limit_b"] = 30
        server.state["client_strength_a"] = 0
        server.state["client_strength_b"] = 0
        server.state["game_client_connected"] = False
        server.active_output_task = None
        server.active_output_clear_after = True
        server.output_watchdog_task = None
        server.output_watchdog_owner = None
        server.output_watchdog_mode = None
        server.shock_lock = asyncio.Lock()
        server.state_lock = asyncio.Lock()
        server.console_connections.clear()
        server.game_connections.clear()
        server.game_connection_last_pulse_at.clear()
        server.game_connection_lightning_next_at.clear()
        server.game_connection_dice_round.clear()
        server.game_connection_lightning_session.clear()
        self.fake_client = FakeDeviceAppClient()
        server.device_app_client = self.fake_client

    async def asyncTearDown(self):
        await server.stop_all_output()
        server.state.clear()
        server.state.update(self.original_state)
        server.device_app_client = self.original_client
        server.active_output_task = self.original_task
        server.active_output_clear_after = self.original_task_clear_after
        server.shock_generation = self.original_generation
        server.output_watchdog_task = self.original_watchdog_task
        server.output_watchdog_owner = self.original_watchdog_owner
        server.output_watchdog_mode = self.original_watchdog_mode
        server.output_watchdog_generation = self.original_watchdog_generation
        server.shock_lock = self.original_shock_lock
        server.state_lock = self.original_state_lock
        server.console_connections.clear()
        server.console_connections.update(self.original_console_connections)
        server.game_connections.clear()
        server.game_connections.update(self.original_game_connections)
        server.game_connection_last_pulse_at.clear()
        server.game_connection_last_pulse_at.update(self.original_last_pulses)
        server.game_connection_lightning_next_at.clear()
        server.game_connection_lightning_next_at.update(self.original_lightning_next)
        server.game_connection_dice_round.clear()
        server.game_connection_dice_round.update(self.original_dice_rounds)
        server.game_connection_lightning_session.clear()
        server.game_connection_lightning_session.update(self.original_lightning_sessions)

    async def test_output_paths_share_limits_reject_overlap_and_confirm_emergency_stop(self):
        """模拟持续控制帧、骰子和角子机，核对限幅、拒绝重叠与 A/B 急停回执。"""
        websocket = ScriptedGameWebSocket([
            # 手持感应：先发一帧持续脉冲，再立即执行用户急停。
            (0, {
                "type": "game_pulse",
                "strength": 18,
                "duration": 100,
                "outputMode": "a",
                "waveform": "game_default",
            }),
            (0.03, {"type": "stop_shock"}),
            # 持续控制帧故意提交超大数值，后端必须按 A=40、B=30 截断。
            (0.24, {
                "type": "game_pulse",
                "strength": 999,
                "duration": 999,
                "outputMode": "ab",
                "bStrengthMode": "percent",
                "bStrengthPercent": 50,
                "waveform": "breathing",
            }),
            (0.03, {"type": "stop_shock"}),
            # 骰子：同一瞬间重复提交只能接受第一条，不能把惩罚排成隐藏队列。
            (0, {
                "type": "dice_round_start",
                "roundId": "dice-four-games-test",
                "plannedCount": 2,
                "singleDuration": 1000,
            }),
            (0, {
                "type": "game_shock_trigger",
                "requestId": 1,
                "game": "dice",
                "phase": "dice_hit",
                "roundId": "dice-four-games-test",
                "sequence": 1,
                "strength": 25,
                "duration": 1000,
                "outputMode": "a",
                "waveform": "random",
            }),
            (0, {
                "type": "game_shock_trigger",
                "requestId": 2,
                "game": "dice",
                "phase": "dice_hit",
                "roundId": "dice-four-games-test",
                "sequence": 2,
                "strength": 25,
                "duration": 1000,
                "outputMode": "a",
                "waveform": "random",
            }),
            # 角子机：骰子任务结束后再走一次 A+B 结算型惩罚。
            (1.05, {
                "type": "game_shock_trigger",
                "requestId": 3,
                "game": "slot",
                "phase": "slot_full",
                "strength": 85,
                "duration": 1000,
                "outputMode": "ab",
                "bStrengthMode": "same",
                "waveform": "pulse",
            }),
            (0.15, {"type": "ping", "time": 123}),
        ])

        await server.web_ws_handler(websocket, f"/game?token={server.GAME_ACCESS_TOKEN}")

        temporary_events = [
            event for event in self.fake_client.events
            if event[0] == "set_temporary_strength"
        ]
        pulse_events = [event for event in self.fake_client.events if event[0] == "send_pulse"]
        clear_channels = [event[1] for event in self.fake_client.events if event[0] == "clear_pulses"]

        # 六次代表：两组持续控制 A 与 A/B；骰子 A；角子机 A/B。若重叠请求被错误排队，这里会多一次。
        self.assertEqual(len(temporary_events), 6, self.fake_client.events)
        self.assertEqual(len(pulse_events), 6)
        self.assertEqual([event[3] for event in pulse_events[1:3]], ["breathing", "breathing"])
        self.assertEqual([event[3] for event in pulse_events[-2:]], ["pulse", "pulse"])
        self.assertTrue(all(event[3] != "random" for event in pulse_events))
        self.assertEqual([event[4] for event in pulse_events[3:]], [1000, 1000, 1000])
        self.assertEqual(
            [(event[1], event[2]) for event in temporary_events],
            [
                (server.Channel.A, 18),
                (server.Channel.A, 40),
                (server.Channel.B, 30),
                (server.Channel.A, 25),
                (server.Channel.A, 40),
                (server.Channel.B, 30),
            ],
        )
        self.assertTrue(all(event[2] <= 40 for event in temporary_events if event[1] == server.Channel.A))
        self.assertTrue(all(event[2] <= 30 for event in temporary_events if event[1] == server.Channel.B))
        self.assertGreaterEqual(clear_channels.count(server.Channel.A), 4)
        self.assertGreaterEqual(clear_channels.count(server.Channel.B), 4)
        self.assertEqual(server.state["client_strength_a"], 0)
        self.assertEqual(server.state["client_strength_b"], 0)

        stop_feedback = [message for message in websocket.sent_messages if message.get("type") == "stop_feedback"]
        self.assertEqual(len(stop_feedback), 2)
        self.assertTrue(all(message["ok"] for message in stop_feedback))

    async def test_game_page_disconnect_cancels_long_output_and_clears_both_channels(self):
        """模拟手机页面在长时惩罚中突然掉线，连接清理必须立即取消任务并清空两路。"""
        websocket = ScriptedGameWebSocket([
            (0, {
                "type": "game_shock_trigger",
                "requestId": 1,
                "game": "slot",
                "phase": "slot_full",
                "strength": 35,
                "duration": 5000,
                "outputMode": "ab",
                "bStrengthMode": "same",
            }),
            # 给后台任务 30ms 下发第一帧，随后脚本结束就等同于页面突然断线。
            (0.03, {"type": "ping", "time": 456}),
        ])

        await server.web_ws_handler(websocket, f"/game?token={server.GAME_ACCESS_TOKEN}")

        clear_channels = [event[1] for event in self.fake_client.events if event[0] == "clear_pulses"]
        self.assertIn(server.Channel.A, clear_channels)
        self.assertIn(server.Channel.B, clear_channels)
        self.assertIsNone(server.active_output_task)
        self.assertEqual(server.state["client_strength_a"], 0)
        self.assertEqual(server.state["client_strength_b"], 0)
        self.assertFalse(server.state["game_client_connected"])

    async def test_lightning_game_has_authoritative_strength_duration_and_rest_limits(self):
        """移动玩法即使被伪造超大参数，也只能执行受限的一轮并拒绝冷却期重叠。"""
        session_id = "lightning-authoritative-test"
        websocket = ScriptedGameWebSocket([
            (0, {
                "type": "lightning_session_start",
                "sessionId": session_id,
                "sessionMinutes": 30,
                "startSpeed": 10,
            }),
            (0, {
                "type": "lightning_safety_sample",
                "sessionId": session_id,
                "mode": "driving",
                "speedKmh": 30,
                "sampleAgeMs": 0,
            }),
            (0, {
                "type": "lightning_shock_trigger",
                "requestId": 1,
                "sessionId": session_id,
                "phase": "driving",
                "strength": 50,
                "duration": 3000,
                "restMs": 3000,
                "speedKmh": 60,
                "sampleAgeMs": 0,
                "outputMode": "a",
            }),
            (0, {
                "type": "lightning_shock_trigger",
                "requestId": 2,
                "sessionId": session_id,
                "phase": "driving",
                "strength": 50,
                "duration": 3000,
                "restMs": 3000,
                "speedKmh": 30,
                "sampleAgeMs": 3001,
                "outputMode": "a",
            }),
            (0, {
                "type": "lightning_shock_trigger",
                "requestId": 3,
                "sessionId": session_id,
                "phase": "driving",
                "strength": 999,
                "duration": 999999,
                "restMs": 0,
                "speedKmh": 30,
                "sampleAgeMs": 0,
                "outputMode": "a",
            }),
            (0.03, {
                "type": "lightning_safety_sample",
                "sessionId": session_id,
                "mode": "jam",
                "speedKmh": 3,
                "sampleAgeMs": 0,
            }),
            (0, {
                "type": "lightning_shock_trigger",
                "requestId": 4,
                "sessionId": session_id,
                "phase": "jam",
                "strength": 50,
                "duration": 1000,
                "speedKmh": 3,
                "sampleAgeMs": 0,
                "outputMode": "a",
            }),
        ])

        await server.web_ws_handler(websocket, f"/game?token={server.GAME_ACCESS_TOKEN}")

        temporary_events = [event for event in self.fake_client.events if event[0] == "set_temporary_strength"]
        pulse_events = [event for event in self.fake_client.events if event[0] == "send_pulse"]
        feedback = [message for message in websocket.sent_messages if message.get("type") == "lightning_feedback"]
        self.assertEqual(len(temporary_events), 1)
        self.assertEqual(temporary_events[0][2], 40)
        self.assertEqual(pulse_events[0][4], server.LIGHTNING_DRIVING_MAX_DURATION_MS)
        self.assertEqual([message["ok"] for message in feedback], [False, False, True, False])
        self.assertIn("60 km/h", feedback[0]["message"])
        self.assertIn("过期", feedback[1]["message"])
        self.assertIn("安全休息", feedback[3]["message"])

    async def test_lightning_invalid_live_sample_stops_active_long_output(self):
        """长输出开始后达到 60 km/h，后台必须依据持续样本立即清空两路。"""
        session_id = "lightning-live-stop-test"
        websocket = ScriptedGameWebSocket([
            (0, {
                "type": "lightning_session_start",
                "sessionId": session_id,
                "sessionMinutes": 30,
                "startSpeed": 10,
            }),
            (0, {
                "type": "lightning_safety_sample",
                "sessionId": session_id,
                "mode": "driving",
                "speedKmh": 35,
                "sampleAgeMs": 0,
            }),
            (0, {
                "type": "lightning_shock_trigger",
                "requestId": 1,
                "sessionId": session_id,
                "phase": "driving",
                "strength": 35,
                "duration": 30000,
                "restMs": 3000,
                "speedKmh": 35,
                "sampleAgeMs": 0,
                "outputMode": "ab",
                "bStrengthMode": "same",
            }),
            (0.03, {
                "type": "lightning_safety_sample",
                "sessionId": session_id,
                "mode": "driving",
                "speedKmh": 60,
                "sampleAgeMs": 0,
            }),
        ])

        await server.web_ws_handler(websocket, f"/game?token={server.GAME_ACCESS_TOKEN}")

        clear_channels = [event[1] for event in self.fake_client.events if event[0] == "clear_pulses"]
        self.assertIn(server.Channel.A, clear_channels)
        self.assertIn(server.Channel.B, clear_channels)
        safety_feedback = [
            message for message in websocket.sent_messages
            if message.get("type") == "lightning_feedback" and message.get("requestId") == 0
        ]
        self.assertTrue(safety_feedback)
        self.assertFalse(safety_feedback[-1]["ok"])

    async def test_dice_backend_enforces_three_hundred_second_output_budget(self):
        """篡改网页连续请求 30 秒骰子惩罚时，后台最多接受 10 下。"""
        round_id = "dice-output-budget-test"
        script = [(0, {
            "type": "dice_round_start",
            "roundId": round_id,
            "plannedCount": 36,
            "singleDuration": 30000,
        })]
        script.extend((0, {
            "type": "game_shock_trigger",
            "requestId": sequence,
            "game": "dice",
            "phase": "dice_hit",
            "roundId": round_id,
            "sequence": sequence,
            "strength": 25,
            "duration": 30000,
            "outputMode": "a",
        }) for sequence in range(1, 12))
        websocket = ScriptedGameWebSocket(script)

        # 本测试只核对协议预算，不等待十个真实 30 秒调度任务。
        with patch.object(server, "schedule_game_shock", return_value=True):
            await server.web_ws_handler(websocket, f"/game?token={server.GAME_ACCESS_TOKEN}")

        feedback = [message for message in websocket.sent_messages if message.get("type") == "game_shock_feedback"]
        self.assertEqual([message["ok"] for message in feedback], [True] * 10 + [False])
        self.assertIn("300 秒", feedback[-1]["message"])

    async def test_untagged_settlement_output_is_rejected(self):
        """省略玩法和阶段不能落入通用长时输出，以免绕过各游戏边界。"""
        websocket = ScriptedGameWebSocket([
            (0, {
                "type": "game_shock_trigger",
                "requestId": 7,
                "strength": 40,
                "duration": 60000,
                "outputMode": "a",
            }),
        ])

        await server.web_ws_handler(websocket, f"/game?token={server.GAME_ACCESS_TOKEN}")

        temporary_events = [event for event in self.fake_client.events if event[0] == "set_temporary_strength"]
        feedback = [message for message in websocket.sent_messages if message.get("type") == "game_shock_feedback"]
        self.assertEqual(temporary_events, [])
        self.assertEqual(len(feedback), 1)
        self.assertFalse(feedback[0]["ok"])
        self.assertIn("未知", feedback[0]["message"])

    async def test_invalid_game_token_never_reaches_fake_hardware(self):
        """没有正确配对令牌的网页应在入口关闭，不能触发任何假硬件命令。"""
        websocket = ScriptedGameWebSocket([
            (0, {"type": "game_shock_trigger", "strength": 40, "duration": 1000}),
        ])

        await server.web_ws_handler(websocket, "/game?token=wrong-token")

        self.assertTrue(websocket.closed)
        self.assertEqual(websocket.close_code, 1008)
        self.assertEqual(self.fake_client.events, [])


if __name__ == "__main__":
    unittest.main()
