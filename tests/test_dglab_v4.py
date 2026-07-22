# -*- coding: utf-8 -*-
"""DG-LAB V4 握手、设备选择、双版本波形和安全 RPC 回归测试。"""

import asyncio
import json
import unittest
from urllib.parse import parse_qs, unquote, urlparse

import websockets

from dglab_v4 import (
    AppSession,
    Channel,
    DGLabV4Bridge,
    DeviceBridgeError,
)
from coyote_waveforms import build_coyote_waveform_frames


class FakeAppWebSocket:
    """记录 V4 下行帧，并可向连接处理器提供有限的上行消息。"""

    def __init__(self, incoming=None):
        self.incoming = list(incoming or [])
        self.sent = []
        self.closed = None

    async def send(self, message):
        self.sent.append(json.loads(message))

    async def close(self, code=1000, reason=""):
        self.closed = (code, reason)

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self.incoming:
            raise StopAsyncIteration
        return self.incoming.pop(0)


def build_device(slot_id="coyote", device_type="COYOTE_020", connected=True, limit_a=80, limit_b=70):
    """构造与 DG-LAB 4 App 快照结构一致的测试设备。"""

    return {
        "slotId": slot_id,
        "name": f"测试设备 {slot_id}",
        "type": device_type,
        "props": {
            "power": 66,
            "intensityA": 12,
            "intensityB": 8,
            "connectState": "connected" if connected else "disconnected",
        },
        "slotState": {
            "hasDevice": connected,
            "channelA": {
                "isMuted": False,
                "intensityMax": limit_a,
                "comfortLimit": {"overheat": False},
            },
            "channelB": {
                "isMuted": False,
                "intensityMax": limit_b,
                "comfortLimit": {"overheat": False},
            },
        },
    }


class V4PulseFrameTests(unittest.TestCase):
    """验证同一感觉会按硬件型号生成不同且合法的完整波形。"""

    def test_v3_default_waveform_has_three_varying_frames_for_300ms(self):
        version, frames = build_coyote_waveform_frames("COYOTE_030", "game_default", 300)

        self.assertEqual(version, 3)
        self.assertEqual(len(frames), 3)
        self.assertEqual(frames[0], [10, 10, 10, 10, 55, 55, 55, 55])
        self.assertGreater(len({tuple(frame) for frame in frames}), 1)

    def test_v2_breathing_waveform_matches_public_little_endian_example(self):
        version, frames = build_coyote_waveform_frames("COYOTE_020", "breathing", 1200)

        self.assertEqual(version, 2)
        self.assertEqual(frames[:2], [[0x21, 0x01, 0x00], [0x21, 0x01, 0x02]])
        packed = frames[5][0] | (frames[5][1] << 8) | (frames[5][2] << 16)
        self.assertEqual(packed & 0x1F, 1)
        self.assertEqual((packed >> 5) & 0x3FF, 9)
        self.assertEqual((packed >> 15) & 0x1F, 20)

    def test_unknown_device_type_is_rejected(self):
        with self.assertRaises(ValueError):
            build_coyote_waveform_frames("UNKNOWN", "game_default", 100)


class V4BridgeTests(unittest.IsolatedAsyncioTestCase):
    """验证 App 握手、设备状态、安全限幅和停止确认。"""

    def attach_devices(self, bridge, devices):
        websocket = FakeAppWebSocket()
        session = AppSession(client_id="app-1", websocket=websocket)
        bridge._sessions[session.client_id] = session
        bridge._apply_app_data(session, {
            "t": "ev",
            "ev": "devices.snapshot",
            "devices": devices,
        })
        bridge._reevaluate_selection()
        return session, websocket

    def test_pairing_url_opens_v4_channel_with_current_target(self):
        bridge = DGLabV4Bridge(target_id="controller-1")

        pairing_url = bridge.pairing_url("192.168.1.20", 15678)
        parsed_pairing = urlparse(pairing_url)
        socket_url = unquote(parse_qs(parsed_pairing.query)["url"][0])

        self.assertEqual(parsed_pairing.netloc, "dungeon-lab.cn")
        self.assertEqual(socket_url, "ws://192.168.1.20:15678/v4?tid=controller-1")

    async def test_valid_connection_receives_official_v4_handshake(self):
        bridge = DGLabV4Bridge(target_id="controller-1")
        websocket = FakeAppWebSocket()

        await bridge.handle_connection(websocket, "/v4?tid=controller-1")

        self.assertEqual(websocket.sent[0]["type"], "hello")
        self.assertEqual(websocket.sent[1], {
            "type": "controller_attached",
            "clientId": "controller-1",
        })

    async def test_wrong_target_is_rejected_before_device_access(self):
        bridge = DGLabV4Bridge(target_id="controller-1")
        websocket = FakeAppWebSocket()

        await bridge.handle_connection(websocket, "/v4?tid=expired")

        self.assertEqual(websocket.sent, [{"type": "error", "code": "controller_not_found"}])
        self.assertEqual(websocket.closed, (4001, "controller_not_found"))

    def test_single_connected_device_is_selected_and_limits_are_exposed(self):
        bridge = DGLabV4Bridge(target_id="controller-1")
        session, _websocket = self.attach_devices(bridge, [build_device()])

        snapshot = bridge.state_snapshot()

        self.assertTrue(snapshot["app_connected"])
        self.assertTrue(snapshot["device_connected"])
        self.assertEqual(snapshot["device_type"], "COYOTE_020")
        self.assertEqual(snapshot["limit_a"], 80)
        self.assertEqual(snapshot["limit_b"], 70)
        self.assertEqual(snapshot["battery_level"], 66)

        # 增量只更新出现的安全字段；未知大对象不能长期积累进设备状态。
        bridge._apply_app_data(session, {
            "t": "ev",
            "ev": "slots.patch",
            "slots": [{
                "slotId": "coyote",
                "props": {"unknownTree": {"payload": "x" * 1000}},
                "slotState": {"channelA": {"intensityMax": 40}},
            }],
        })
        patched = bridge.state_snapshot()
        self.assertEqual(patched["limit_a"], 40)
        self.assertEqual(patched["limit_b"], 70)
        self.assertNotIn("unknownTree", session.devices["coyote"]["props"])

    async def test_multiple_devices_require_explicit_selection(self):
        bridge = DGLabV4Bridge(target_id="controller-1")
        self.attach_devices(bridge, [
            build_device("v2", "COYOTE_020"),
            build_device("v3", "COYOTE_030"),
        ])

        before = bridge.state_snapshot()
        self.assertTrue(before["selection_required"])
        self.assertFalse(before["device_connected"])

        v3_selection = next(
            device["selection_id"] for device in before["devices"] if device["type"] == "COYOTE_030"
        )
        await bridge.select_device(v3_selection)
        after = bridge.state_snapshot()

        self.assertFalse(after["selection_required"])
        self.assertEqual(after["device_type"], "COYOTE_030")

    async def test_overheat_blocks_nonzero_output_but_still_allows_stop(self):
        bridge = DGLabV4Bridge(target_id="controller-1")
        device = build_device()
        device["slotState"]["channelA"]["comfortLimit"]["overheat"] = True
        session, websocket = self.attach_devices(bridge, [device])

        with self.assertRaises(DeviceBridgeError):
            await bridge.set_temporary_strength(Channel.A, 5, 500)

        clear_task = asyncio.create_task(bridge.clear_pulses(Channel.A))
        await asyncio.sleep(0)
        request = websocket.sent[-1]["data"]
        bridge._resolve_response(session.client_id, {
            "t": "resp",
            "reqId": request["reqId"],
            "result": {},
        })
        await clear_task

    async def test_v2_pulse_request_carries_full_duration_aligned_frame_list(self):
        bridge = DGLabV4Bridge(target_id="controller-1")
        _session, websocket = self.attach_devices(bridge, [build_device()])

        await bridge.send_pulse(Channel.B, 20, "breathing", duration_ms=500)
        request = websocket.sent[-1]["data"]
        operation = request["data"]

        self.assertEqual(request["m"], "device.op")
        self.assertEqual(operation["c"], 1)
        self.assertEqual(operation["ver"], 2)
        self.assertEqual(operation["d"], 500)
        self.assertEqual(len(operation["v"]), 5)
        self.assertTrue(all(len(frame) == 3 for frame in operation["v"]))
        self.assertGreater(len({tuple(frame) for frame in operation["v"]}), 1)
        self.assertTrue(operation["im"])

    async def test_longest_v3_waveform_stays_within_app_message_limit(self):
        """60 秒波形不能膨胀到超过 App 网关的 64 KiB 消息边界。"""

        bridge = DGLabV4Bridge(target_id="controller-1")
        device = build_device()
        device["type"] = "COYOTE_030"
        _session, websocket = self.attach_devices(bridge, [device])

        await bridge.send_pulse(Channel.A, 20, "pulse", duration_ms=60000)
        request = websocket.sent[-1]["data"]

        self.assertEqual(len(request["data"]["v"]), 600)
        self.assertLess(len(json.dumps(request).encode("utf-8")), 65536)

    async def test_request_over_app_limit_is_rejected_server_side(self):
        bridge = DGLabV4Bridge(target_id="controller-1")
        session, _websocket = self.attach_devices(bridge, [build_device(limit_a=15)])

        with self.assertRaises(DeviceBridgeError):
            await bridge.set_temporary_strength(Channel.A, 16, 500)

        session.devices["coyote"]["props"]["channelAStatus"] = 3
        with self.assertRaises(DeviceBridgeError):
            await bridge.set_temporary_strength(Channel.A, 5, 500)
        self.assertEqual(bridge.state_snapshot()["limit_a"], 0)

    async def test_real_websocket_round_trip_completes_stop_rpc(self):
        """真实 WebSocket 握手、设备快照和停止回执必须能走完整链路。"""
        device_ready = asyncio.Event()

        async def on_state(snapshot):
            if snapshot["device_connected"]:
                device_ready.set()

        bridge = DGLabV4Bridge(state_callback=on_state, target_id="controller-1")
        socket_server = await websockets.serve(bridge.handle_connection, "127.0.0.1", 0)
        port = socket_server.sockets[0].getsockname()[1]
        try:
            async with websockets.connect(
                f"ws://127.0.0.1:{port}/v4?tid=controller-1"
            ) as app_socket:
                hello = json.loads(await app_socket.recv())
                attached = json.loads(await app_socket.recv())
                self.assertEqual(hello["type"], "hello")
                self.assertEqual(attached["type"], "controller_attached")

                await app_socket.send(json.dumps({
                    "type": "message",
                    "data": {
                        "t": "ev",
                        "ev": "devices.snapshot",
                        "devices": [build_device()],
                    },
                }))
                await asyncio.wait_for(device_ready.wait(), timeout=1)

                clear_task = asyncio.create_task(bridge.clear_pulses(Channel.A))
                request_frame = json.loads(await asyncio.wait_for(app_socket.recv(), timeout=1))
                request = request_frame["data"]
                self.assertEqual(request["m"], "device.op.clear")
                await app_socket.send(json.dumps({
                    "type": "message",
                    "data": {
                        "t": "resp",
                        "reqId": request["reqId"],
                        "result": {},
                    },
                }))
                await clear_task
        finally:
            await bridge.close()
            socket_server.close()
            await socket_server.wait_closed()


if __name__ == "__main__":
    unittest.main()
