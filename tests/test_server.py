# -*- coding: utf-8 -*-
"""后端安全边界、硬件限幅与输出调度的回归测试。"""

import asyncio
import threading
import unittest
from http.server import ThreadingHTTPServer
from types import SimpleNamespace
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import server


class FakeWebSocket:
    """只提供控制台鉴权所需字段，避免测试依赖真实浏览器连接。"""

    def __init__(self, remote_host, origin):
        self.remote_address = (remote_host, 12345)
        self.request_headers = {"Origin": origin} if origin is not None else {}


class FakeDeviceAppClient:
    """记录硬件调用顺序，不连接真实设备 App 或硬件。"""

    def __init__(self, fail_clear_channel=None):
        self.events = []
        self.fail_clear_channel = fail_clear_channel

    async def set_strength(self, channel, operation_type, value):
        self.events.append(("set_strength", channel, operation_type, value))

    async def add_pulses(self, channel, pulse):
        self.events.append(("add_pulses", channel, pulse))

    async def clear_pulses(self, channel):
        self.events.append(("clear_pulses", channel))
        if channel == self.fail_clear_channel:
            raise RuntimeError("模拟单通道停止失败")


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

    def test_reads_real_bridge_limit_field_names(self):
        """当前桥接库使用 a_limit/b_limit，必须读取到真实限幅。"""
        packet = SimpleNamespace(a=12, b=34, a_limit=80, b_limit=65)

        server.update_hardware_state_from_data(packet)

        self.assertEqual(server.state["client_strength_a"], 12)
        self.assertEqual(server.state["client_strength_b"], 34)
        self.assertEqual(server.state["limit_a"], 80)
        self.assertEqual(server.state["limit_b"], 65)

    def test_unknown_limits_disable_output(self):
        """App 尚未回传限幅时不能擅自按协议最大值 200 输出。"""
        server.state["limit_a"] = None
        server.state["limit_b"] = None

        targets = server.build_channel_strengths(100, "ab", "same", 100)

        self.assertEqual(targets, [])

    def test_dual_channel_requires_both_limits(self):
        """A+B 是一个整体选择，缺少 B 限幅时不能悄悄退化成只输出 A。"""
        server.state["limit_a"] = 80
        server.state["limit_b"] = None

        targets = server.build_channel_strengths(30, "ab", "same", 100)

        self.assertEqual(targets, [])

    def test_non_finite_numbers_fall_back_without_crashing(self):
        """JSON 可解析出 Infinity/NaN；这些值不能让整数转换抛异常并断开连接。"""
        self.assertEqual(server.clamp_int(float("inf"), 0, 200, fallback=7), 7)
        self.assertEqual(server.clamp_int(float("nan"), 0, 200, fallback=9), 9)

    def test_non_ascii_game_token_is_rejected_without_exception(self):
        """恶意查询参数可能包含中文；校验应稳定返回失败，而不是抛出字符串比较异常。"""
        self.assertFalse(server.is_valid_game_token("无效令牌"))
        self.assertTrue(server.is_valid_game_token(server.GAME_ACCESS_TOKEN))

    def test_strengths_are_clamped_per_channel(self):
        """A/B 两路分别受自己的 App 限幅控制，比例模式也要先计算再限幅。"""
        server.state["limit_a"] = 40
        server.state["limit_b"] = 30

        targets = server.build_channel_strengths(100, "ab", "percent", 50)

        self.assertEqual(
            targets,
            [
                (server.Channel.A, 40, "client_strength_a"),
                (server.Channel.B, 30, "client_strength_b"),
            ],
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
        self.assertTrue(response.geturl().endswith("/static/index.html"))
        self.assertEqual(response.headers["Referrer-Policy"], "no-referrer")
        self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(response.headers["Cache-Control"], "no-store")

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
        self.original_generation = server.shock_generation

        server.state["app_connected"] = True
        server.state["limit_a"] = 100
        server.state["limit_b"] = 100
        server.state["client_strength_a"] = 0
        server.state["client_strength_b"] = 0
        server.active_output_task = None
        server.device_app_client = FakeDeviceAppClient()

    async def asyncTearDown(self):
        await server.stop_all_output()
        server.state.clear()
        server.state.update(self.original_state)
        server.device_app_client = self.original_client
        server.active_output_task = self.original_task
        server.shock_generation = self.original_generation

    async def test_overlapping_output_is_rejected_without_queueing(self):
        first = server.schedule_game_shock(20, 1000, "a", "same", 100, clear_after=True)
        second = server.schedule_game_shock(20, 1000, "a", "same", 100, clear_after=True)

        self.assertTrue(first)
        self.assertFalse(second)

        await asyncio.sleep(0)
        await server.stop_all_output()
        self.assertIsNone(server.active_output_task)
        self.assertEqual(server.state["client_strength_a"], 0)

    async def test_stop_continues_with_b_when_a_clear_fails(self):
        fake_client = FakeDeviceAppClient(fail_clear_channel=server.Channel.A)
        server.device_app_client = fake_client

        # 这里故意制造 A 通道失败；屏蔽预期日志，测试结果只关注 B 是否仍被清空。
        with patch("builtins.print"):
            await server.stop_all_output()

        cleared_channels = [event[1] for event in fake_client.events if event[0] == "clear_pulses"]
        self.assertEqual(cleared_channels, [server.Channel.A, server.Channel.B])
        self.assertEqual(server.state["client_strength_a"], 0)
        self.assertEqual(server.state["client_strength_b"], 0)
        server.device_app_client = FakeDeviceAppClient()


if __name__ == "__main__":
    unittest.main()
