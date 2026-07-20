# -*- coding: utf-8 -*-
"""DG-LAB 4 App 的本地 V4 Socket 桥接与郊狼双版本波形适配。"""

import asyncio
import json
import math
import secrets
import time
from dataclasses import dataclass, field
from enum import IntEnum
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, quote, urlparse


SUPPORTED_DEVICE_TYPES = {
    "COYOTE_020": {"label": "郊狼 2.0", "wave_version": 2},
    "COYOTE_030": {"label": "郊狼 3.0", "wave_version": 3},
}
MAX_APP_CONNECTIONS = 4
MAX_DEVICE_COUNT_PER_APP = 16
MAX_IDENTIFIER_LENGTH = 128
MAX_TEXT_VALUE_LENGTH = 256
RPC_TIMEOUT_SECONDS = 1.0
APP_HEARTBEAT_SECONDS = 30.0


class Channel(IntEnum):
    """V4 协议通道编号；A/B 分别固定为 0/1。"""

    A = 0
    B = 1


class DeviceBridgeError(RuntimeError):
    """设备未就绪、协议被拒绝或 App 未确认指令时使用的统一异常。"""


@dataclass
class AppSession:
    """保存一个 DG-LAB App 连接及它当前公开的设备快照。"""

    client_id: str
    websocket: Any
    devices: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    heartbeat_task: Optional[asyncio.Task] = None


@dataclass
class PendingRequest:
    """把 V4 的 reqId 与等待确认的本地协程关联起来。"""

    client_id: str
    future: asyncio.Future


def _clamp_int(value: Any, minimum: int, maximum: int, fallback: int = 0) -> int:
    """安全转换外部数值，拒绝 NaN、Infinity 和无法转换的对象。"""

    try:
        number = float(value)
        if not math.isfinite(number):
            raise ValueError("数值不是有限值")
        integer = int(round(number))
    except (TypeError, ValueError, OverflowError):
        integer = fallback
    return max(minimum, min(maximum, integer))


def _safe_number(value: Any, minimum: int, maximum: int) -> Optional[int]:
    """读取 App 回传的硬件数值；未知值保持 None，不能伪装成安全的 0。"""

    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(float(value)):
        return None
    return _clamp_int(value, minimum, maximum)


def _deep_merge(current: Any, patch: Any, depth: int = 0) -> Any:
    """按 V4 增量事件深合并设备状态，并限制递归深度避免异常数据消耗资源。"""

    if depth >= 6 or not isinstance(current, dict) or not isinstance(patch, dict):
        return patch

    merged = dict(current)
    for key, value in patch.items():
        if not isinstance(key, str):
            continue
        merged[key] = _deep_merge(current.get(key), value, depth + 1)
    return merged


def _normalized_identifier(value: Any) -> Optional[str]:
    """只接受短而非空的文本标识，避免畸形 slotId 进入状态表和日志。"""

    if not isinstance(value, str):
        return None
    normalized = value.strip()
    if not normalized or len(normalized) > MAX_IDENTIFIER_LENGTH:
        return None
    return normalized


def _sanitize_props(raw_props: Any) -> Dict[str, Any]:
    """只保留郊狼状态展示与安全判断需要的属性，阻止增量事件无限堆积未知键。"""

    if not isinstance(raw_props, dict):
        return {}
    allowed_keys = {
        "power",
        "version",
        "label",
        "intensityA",
        "intensityB",
        "connectState",
        "channelAStatus",
        "channelBStatus",
        "updateValue",
    }
    sanitized = {}
    for key in allowed_keys:
        value = raw_props.get(key)
        if isinstance(value, str):
            sanitized[key] = value[:MAX_TEXT_VALUE_LENGTH]
        elif isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value)):
            sanitized[key] = value
    return sanitized


def _sanitize_channel_state(raw_channel: Any) -> Dict[str, Any]:
    """清洗 A/B 通道安全字段，同时保留 V4 舒适限幅所需的已知子项。"""

    if not isinstance(raw_channel, dict):
        return {}
    sanitized = {}
    for key in ("isMuted", "warmUpScale", "intensityMax"):
        value = raw_channel.get(key)
        if isinstance(value, bool) or (
            isinstance(value, (int, float))
            and not isinstance(value, bool)
            and math.isfinite(float(value))
        ):
            sanitized[key] = value

    raw_limit = raw_channel.get("comfortLimit")
    if isinstance(raw_limit, dict):
        comfort_limit = {}
        for key in (
            "mode",
            "comfortMax",
            "absoluteMax",
            "overheat",
            "overheatPercent",
            "autoIncr",
            "autoIncrMax",
            "autoIncrScope",
            "totalIncr",
        ):
            value = raw_limit.get(key)
            if isinstance(value, str):
                comfort_limit[key] = value[:32]
            elif isinstance(value, bool) or (
                isinstance(value, (int, float))
                and not isinstance(value, bool)
                and math.isfinite(float(value))
            ):
                comfort_limit[key] = value
        sanitized["comfortLimit"] = comfort_limit
    return sanitized


def _sanitize_slot_state(raw_slot_state: Any) -> Dict[str, Any]:
    """保留真实设备、标记灯和两路安全状态，忽略与郊狼控制无关的扩展树。"""

    if not isinstance(raw_slot_state, dict):
        return {}
    sanitized = {}
    if isinstance(raw_slot_state.get("hasDevice"), bool):
        sanitized["hasDevice"] = raw_slot_state["hasDevice"]
    if raw_slot_state.get("markLight") is None or isinstance(raw_slot_state.get("markLight"), str):
        mark_light = raw_slot_state.get("markLight")
        sanitized["markLight"] = mark_light[:32] if isinstance(mark_light, str) else None
    if "channelA" in raw_slot_state:
        sanitized["channelA"] = _sanitize_channel_state(raw_slot_state.get("channelA"))
    if "channelB" in raw_slot_state:
        sanitized["channelB"] = _sanitize_channel_state(raw_slot_state.get("channelB"))
    return sanitized


def _normalize_device(raw_device: Any) -> Optional[Dict[str, Any]]:
    """保留 V4 控制所需的设备字段，丢弃结构不合法的设备条目。"""

    if not isinstance(raw_device, dict):
        return None

    slot_id = _normalized_identifier(raw_device.get("slotId"))
    device_type = _normalized_identifier(raw_device.get("type"))
    if slot_id is None or device_type is None:
        return None

    raw_name = raw_device.get("name")
    name = raw_name.strip()[:MAX_IDENTIFIER_LENGTH] if isinstance(raw_name, str) else device_type
    props = _sanitize_props(raw_device.get("props"))
    slot_state = _sanitize_slot_state(raw_device.get("slotState"))
    return {
        "slotId": slot_id,
        "name": name or device_type,
        "type": device_type,
        "props": props,
        "slotState": slot_state,
    }


def _device_is_connected(device: Dict[str, Any]) -> bool:
    """只有 App 明确报告有真实蓝牙设备时才允许成为输出目标。"""

    slot_state = device.get("slotState") if isinstance(device.get("slotState"), dict) else {}
    props = device.get("props") if isinstance(device.get("props"), dict) else {}
    connect_state = props.get("connectState")
    explicitly_disconnected = isinstance(connect_state, str) and connect_state.lower() != "connected"
    return slot_state.get("hasDevice") is True and not explicitly_disconnected


def _channel_snapshot(device: Dict[str, Any], channel_name: str) -> Dict[str, Any]:
    """提取单通道限幅、静音与过热状态，输出侧只使用处理后的有效上限。"""

    slot_state = device.get("slotState") if isinstance(device.get("slotState"), dict) else {}
    channel_state = slot_state.get(channel_name) if isinstance(slot_state.get(channel_name), dict) else {}
    comfort_limit = (
        channel_state.get("comfortLimit")
        if isinstance(channel_state.get("comfortLimit"), dict)
        else {}
    )
    raw_limit = _safe_number(channel_state.get("intensityMax"), 0, 200)
    muted = channel_state.get("isMuted") is True
    overheat = comfort_limit.get("overheat") is True
    effective_limit = 0 if muted or overheat else raw_limit
    return {
        "limit": effective_limit,
        "raw_limit": raw_limit,
        "muted": muted,
        "overheat": overheat,
    }


def build_coyote_pulse_frame(device_type: str, channel_strength: int) -> Tuple[int, List[int]]:
    """按选中硬件生成一帧 100ms 波形，返回 ``(协议版本, 字节数组)``。

    项目原有 V3 体感使用 100ms 周期、通道强度约一半作为波形强度。这里保持该行为；
    郊狼 2.0 再按官方映射把 V3 波形强度除以 5，并编码为小端 X/Y/Z 三字节帧。
    """

    if device_type not in SUPPORTED_DEVICE_TYPES:
        raise DeviceBridgeError("当前设备型号不是受支持的郊狼 2.0 或 3.0")

    safe_strength = _clamp_int(channel_strength, 1, 200, fallback=1)
    wave_strength = _clamp_int(round(safe_strength / 2), 1, 100, fallback=1)

    if device_type == "COYOTE_030":
        return 3, [100, 100, 100, 100, wave_strength, wave_strength, wave_strength, wave_strength]

    # V2 的 Frequency = X + Y。100ms 周期按官方建议公式得到 X≈5、Y≈95。
    frequency = 100
    pulse_width_x = _clamp_int(round(math.sqrt(frequency / 1000) * 15), 1, 31, fallback=5)
    pause_y = _clamp_int(frequency - pulse_width_x, 0, 1023, fallback=95)
    wave_z = _clamp_int(round(wave_strength / 5), 1, 20, fallback=1)
    packed = pulse_width_x | (pause_y << 5) | (wave_z << 15)
    return 2, [packed & 0xFF, (packed >> 8) & 0xFF, (packed >> 16) & 0xFF]


class DGLabV4Bridge:
    """直接在本机承接 DG-LAB 4 App，避免额外引入 Node/Bun 中继进程。"""

    def __init__(
        self,
        state_callback: Optional[Callable[[Dict[str, Any]], Awaitable[None]]] = None,
        action_callback: Optional[Callable[[int], Awaitable[None]]] = None,
        target_id: Optional[str] = None,
    ) -> None:
        self.target_id = target_id or secrets.token_hex(8)
        self._state_callback = state_callback
        self._action_callback = action_callback
        self._sessions: Dict[str, AppSession] = {}
        self._pending: Dict[str, PendingRequest] = {}
        self._selected_key: Optional[Tuple[str, str]] = None
        self._selection_required = False
        self._closed = False

    @property
    def has_app(self) -> bool:
        """是否至少有一个 DG-LAB App 已完成 V4 WebSocket 接入。"""

        return bool(self._sessions)

    def pairing_url(self, host: str, port: int) -> str:
        """生成 DG-LAB 4 App 能识别的 V4 深链二维码内容。"""

        socket_url = f"ws://{host}:{port}/v4?tid={quote(self.target_id, safe='')}"
        encoded_socket_url = quote(socket_url, safe="")
        return f"https://dungeon-lab.cn/s/?v=1&action=socket&url={encoded_socket_url}"

    async def handle_connection(self, websocket: Any, path: Optional[str] = None) -> None:
        """校验配对 ID、完成 V4 被控方握手，并持续处理 App 上行事件。"""

        request_path = path or getattr(websocket, "path", "/")
        parsed = urlparse(request_path)
        target_id = parse_qs(parsed.query).get("tid", [""])[0]
        valid_path = parsed.path in {"/v4", "/v4/"}
        valid_target = (
            isinstance(target_id, str)
            and len(target_id) == len(self.target_id)
            and secrets.compare_digest(target_id, self.target_id)
        )
        if not valid_path or not valid_target or self._closed:
            await self._reject_connection(websocket, "controller_not_found")
            return
        if len(self._sessions) >= MAX_APP_CONNECTIONS:
            await self._reject_connection(websocket, "too_many_clients", close_code=1013)
            return

        client_id = self._new_client_id()
        session = AppSession(client_id=client_id, websocket=websocket)
        self._sessions[client_id] = session
        try:
            await websocket.send(json.dumps({"type": "hello", "clientId": client_id}))
            await websocket.send(json.dumps({"type": "controller_attached", "clientId": self.target_id}))
            session.heartbeat_task = asyncio.create_task(self._heartbeat_loop(session))
            await self._notify_state()

            async for raw_message in websocket:
                await self._handle_frame(session, raw_message)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            # 正常断网、App 退后台和蓝牙页面退出都会落到这里，状态清理必须继续执行。
            print(f"DG-LAB App V4 连接结束: {error}")
        finally:
            if session.heartbeat_task and not session.heartbeat_task.done():
                session.heartbeat_task.cancel()
                await asyncio.gather(session.heartbeat_task, return_exceptions=True)
            self._sessions.pop(client_id, None)
            self._reject_pending_for_client(client_id, DeviceBridgeError("DG-LAB App 已断开"))
            if self._selected_key and self._selected_key[0] == client_id:
                self._selected_key = None
                self._selection_required = True
            self._reevaluate_selection()
            await self._notify_state()

    async def close(self) -> None:
        """服务退出时通知所有 App 控制方已离线，并关闭未完成的请求。"""

        self._closed = True
        sessions = list(self._sessions.values())
        for session in sessions:
            try:
                await session.websocket.send(json.dumps({
                    "type": "controller_disconnected",
                    "clientId": self.target_id,
                }))
            except Exception:
                pass
            try:
                await session.websocket.close(code=4000, reason="controller_disconnected")
            except Exception:
                pass
        self._reject_all_pending(DeviceBridgeError("V4 桥接服务已停止"))

    async def select_device(self, selection_id: str) -> Dict[str, Any]:
        """明确选择输出硬件；多设备场景禁止静默控制列表中的第一台。"""

        candidate = next(
            (item for item in self._compatible_devices() if item["selection_id"] == selection_id),
            None,
        )
        if candidate is None or not candidate["connected"]:
            raise DeviceBridgeError("目标设备不存在或蓝牙尚未连接")
        self._selected_key = (candidate["client_id"], candidate["slot_id"])
        self._selection_required = False
        await self._notify_state()
        return self.state_snapshot()

    async def measure_latency(self) -> int:
        """通过 V4 应用层 ping 测量电脑到 App 的完整往返延迟。"""

        if not self._sessions:
            raise DeviceBridgeError("DG-LAB App 尚未连接")
        session = next(iter(self._sessions.values()))
        start = asyncio.get_running_loop().time()
        await self._send_request(session, "ping", wait_for_response=True, timeout_seconds=2.0)
        return int((asyncio.get_running_loop().time() - start) * 1000)

    async def set_temporary_strength(self, channel: Channel, value: int, duration_ms: int) -> None:
        """设置带自动到期时间的非零强度；电脑失联后 App 仍会自行归零。"""

        session, device = self._active_target(channel, value)
        payload = {
            "s": device["slotId"],
            "t": 4,
            "c": int(channel),
            "p": 2,
            "d": _clamp_int(duration_ms, 100, 61000, fallback=100),
            "im": True,
            "v": _clamp_int(value, 1, 200, fallback=1),
        }
        await self._send_request(session, "device.op", payload, wait_for_response=False)

    async def send_pulse(self, channel: Channel, channel_strength: int, duration_ms: int = 100) -> None:
        """根据当前选中设备自动发送 V2 或 V3 裸波形帧。"""

        session, device = self._active_target(channel, channel_strength)
        wave_version, frame = build_coyote_pulse_frame(device["type"], channel_strength)
        payload = {
            "s": device["slotId"],
            "t": 0,
            "c": int(channel),
            "p": 2,
            "d": _clamp_int(duration_ms, 100, 1000, fallback=100),
            "im": True,
            "v": [frame],
            "ver": wave_version,
        }
        await self._send_request(session, "device.op", payload, wait_for_response=False)

    async def clear_pulses(self, channel: Channel) -> None:
        """清理选中设备指定通道的全部 V4 任务，并等待 App 明确确认。"""

        session, device = self._active_target(allow_blocked=True)
        await self._send_request(
            session,
            "device.op.clear",
            {"s": device["slotId"], "c": int(channel)},
            wait_for_response=True,
        )

    async def reset_strength(self, channel: Channel) -> None:
        """使用 V4 唯一允许的绝对强度值 0 再做一次硬归零。"""

        session, device = self._active_target(allow_blocked=True)
        payload = {
            "s": device["slotId"],
            "t": 7,
            "c": int(channel),
            "p": 2,
            "im": True,
            "v": 0,
        }
        await self._send_request(session, "device.op", payload, wait_for_response=True)

    def state_snapshot(self) -> Dict[str, Any]:
        """生成可直接交给后端状态机的无敏感信息快照。"""

        devices = self._compatible_devices()
        selected = next((item for item in devices if item["selected"]), None)
        selected_device = self._get_selected_device()
        props = selected_device[1].get("props", {}) if selected_device else {}
        channel_a = _channel_snapshot(selected_device[1], "channelA") if selected_device else {}
        channel_b = _channel_snapshot(selected_device[1], "channelB") if selected_device else {}
        channel_status_a = props.get("channelAStatus") if selected else None
        channel_status_b = props.get("channelBStatus") if selected else None
        if channel_status_a in {3, 4}:
            channel_a["limit"] = 0
        if channel_status_b in {3, 4}:
            channel_b["limit"] = 0
        connected = bool(selected and selected["connected"])

        safety_reasons = []
        if channel_a.get("overheat") or channel_b.get("overheat"):
            safety_reasons.append("设备报告通道过热，已禁止输出")
        if channel_a.get("muted"):
            safety_reasons.append("A 通道已静音")
        if channel_b.get("muted"):
            safety_reasons.append("B 通道已静音")
        if channel_status_a in {3, 4} or channel_status_b in {3, 4}:
            safety_reasons.append("设备报告通道异常或已屏蔽，已禁止对应输出")

        if not self._sessions:
            status_message = "等待 DG-LAB 4 App 扫码"
        elif not devices:
            status_message = "App 已连接，请先在 App 中添加并连接郊狼设备"
        elif self._selection_required or selected is None:
            status_message = "检测到多个设备或原设备已离线，请明确选择控制目标"
        elif not connected:
            status_message = "已选设备的蓝牙连接尚未就绪"
        elif safety_reasons:
            status_message = "；".join(safety_reasons)
        elif channel_a.get("raw_limit") is None or channel_b.get("raw_limit") is None:
            status_message = "设备已连接，正在等待 App 回传 A/B 安全上限"
        else:
            status_message = f"{selected['model']} 已就绪"

        return {
            "app_connected": bool(self._sessions),
            "app_count": len(self._sessions),
            "device_connected": connected,
            "device_count": len(devices),
            "selection_required": self._selection_required or (bool(devices) and selected is None),
            "selected_device_id": selected["selection_id"] if selected else None,
            "device_type": selected["type"] if selected else None,
            "device_model": selected["model"] if selected else None,
            "device_name": selected["name"] if selected else None,
            "client_strength_a": _safe_number(props.get("intensityA"), 0, 200) if selected else None,
            "client_strength_b": _safe_number(props.get("intensityB"), 0, 200) if selected else None,
            "limit_a": channel_a.get("limit"),
            "limit_b": channel_b.get("limit"),
            "battery_level": _safe_number(props.get("power"), 0, 100) if selected else None,
            "muted_a": channel_a.get("muted", False),
            "muted_b": channel_b.get("muted", False),
            "overheat_a": channel_a.get("overheat", False),
            "overheat_b": channel_b.get("overheat", False),
            "channel_status_a": channel_status_a,
            "channel_status_b": channel_status_b,
            "bridge_protocol": "V4",
            "device_status_message": status_message,
            "devices": devices,
        }

    async def _handle_frame(self, session: AppSession, raw_message: Any) -> None:
        """解析一条 App 消息；未知扩展字段被忽略，非法结构不会断开整个服务。"""

        if isinstance(raw_message, bytes):
            try:
                raw_message = raw_message.decode("utf-8")
            except UnicodeDecodeError:
                return
        if not isinstance(raw_message, str):
            return
        try:
            frame = json.loads(raw_message)
        except (json.JSONDecodeError, ValueError):
            return
        if not isinstance(frame, dict):
            return

        frame_type = frame.get("type")
        if frame_type == "ping":
            await session.websocket.send(json.dumps({"type": "pong", "ts": int(time.time() * 1000)}))
            return
        if frame_type != "message" or not isinstance(frame.get("data"), dict):
            return

        data = frame["data"]
        changed = self._apply_app_data(session, data)
        if data.get("t") == "resp":
            self._resolve_response(session.client_id, data)
        elif (
            data.get("t") == "ev"
            and data.get("ev") == "custom.action"
            and isinstance(data.get("action"), int)
            and not isinstance(data.get("action"), bool)
            and 0 <= data["action"] <= 9
            and self._action_callback
        ):
            await self._action_callback(data["action"])

        if changed:
            self._reevaluate_selection()
            await self._notify_state()

    def _apply_app_data(self, session: AppSession, data: Dict[str, Any]) -> bool:
        """应用设备快照、设备增删或插槽增量，返回是否改变了设备状态。"""

        if data.get("t") == "resp":
            result = data.get("result")
            devices = result.get("devices") if isinstance(result, dict) else None
            if isinstance(devices, list):
                self._replace_devices(session, devices)
                return True
            return False

        if data.get("t") != "ev":
            return False
        event_name = data.get("ev")
        if event_name == "devices.snapshot":
            devices = data.get("devices") if isinstance(data.get("devices"), list) else []
            self._replace_devices(session, devices)
            return True
        if event_name == "devices.patch":
            added = data.get("added") if isinstance(data.get("added"), list) else []
            removed = data.get("removed") if isinstance(data.get("removed"), list) else []
            for raw_device in added[:MAX_DEVICE_COUNT_PER_APP]:
                device = _normalize_device(raw_device)
                if device:
                    session.devices[device["slotId"]] = device
            for raw_slot_id in removed[:MAX_DEVICE_COUNT_PER_APP]:
                slot_id = _normalized_identifier(raw_slot_id)
                if slot_id:
                    session.devices.pop(slot_id, None)
            return True
        if event_name == "slots.patch":
            slots = data.get("slots") if isinstance(data.get("slots"), list) else []
            for patch in slots[:MAX_DEVICE_COUNT_PER_APP]:
                if not isinstance(patch, dict):
                    continue
                slot_id = _normalized_identifier(patch.get("slotId"))
                device = session.devices.get(slot_id) if slot_id else None
                if device is None:
                    continue
                if isinstance(patch.get("props"), dict):
                    device["props"] = _deep_merge(
                        device.get("props", {}),
                        _sanitize_props(patch["props"]),
                    )
                if isinstance(patch.get("slotState"), dict):
                    device["slotState"] = _deep_merge(
                        device.get("slotState", {}),
                        _sanitize_slot_state(patch["slotState"]),
                    )
            return True
        return False

    def _replace_devices(self, session: AppSession, raw_devices: List[Any]) -> None:
        """用完整快照原子替换某个 App 的设备表，避免保留已经移除的硬件。"""

        next_devices = {}
        for raw_device in raw_devices[:MAX_DEVICE_COUNT_PER_APP]:
            device = _normalize_device(raw_device)
            if device:
                next_devices[device["slotId"]] = device
        session.devices = next_devices

    def _compatible_devices(self) -> List[Dict[str, Any]]:
        """返回控制台可展示的受支持设备，不泄露 App 消息和内部任务。"""

        devices = []
        for client_id, session in self._sessions.items():
            for slot_id, device in session.devices.items():
                device_type = device.get("type")
                model = SUPPORTED_DEVICE_TYPES.get(device_type)
                if model is None:
                    continue
                selected = self._selected_key == (client_id, slot_id)
                devices.append({
                    "selection_id": f"{client_id}:{slot_id}",
                    "client_id": client_id,
                    "slot_id": slot_id,
                    "name": device.get("name") or model["label"],
                    "type": device_type,
                    "model": model["label"],
                    "wave_version": model["wave_version"],
                    "connected": _device_is_connected(device),
                    "selected": selected,
                })
        devices.sort(key=lambda item: (not item["connected"], item["model"], item["name"], item["selection_id"]))
        return devices

    def _reevaluate_selection(self) -> None:
        """单设备首次连接可自动选择；设备切换或多设备必须由用户明确确认。"""

        if not self._sessions:
            # 全部 App 断开后不会有可继续的输出；下次重新扫码时允许单设备恢复自动选择。
            self._selected_key = None
            self._selection_required = False
            return

        connected = [item for item in self._compatible_devices() if item["connected"]]
        if self._selected_key:
            selected_still_valid = any(
                (item["client_id"], item["slot_id"]) == self._selected_key for item in connected
            )
            if selected_still_valid:
                return
            self._selected_key = None
            self._selection_required = True

        if self._selection_required:
            return
        if len(connected) == 1:
            self._selected_key = (connected[0]["client_id"], connected[0]["slot_id"])
        elif len(connected) > 1:
            self._selection_required = True

    def _get_selected_device(self) -> Optional[Tuple[AppSession, Dict[str, Any]]]:
        """返回当前明确选择的 App 会话和设备快照。"""

        if self._selected_key is None:
            return None
        client_id, slot_id = self._selected_key
        session = self._sessions.get(client_id)
        device = session.devices.get(slot_id) if session else None
        if session is None or device is None:
            return None
        return session, device

    def _active_target(
        self,
        channel: Optional[Channel] = None,
        requested_strength: Optional[int] = None,
        allow_blocked: bool = False,
    ) -> Tuple[AppSession, Dict[str, Any]]:
        """在每次硬件写入前重新验证连接、型号、限幅、静音和过热状态。"""

        selected = self._get_selected_device()
        if selected is None:
            raise DeviceBridgeError("尚未选择可控制的郊狼设备")
        session, device = selected
        if device.get("type") not in SUPPORTED_DEVICE_TYPES:
            raise DeviceBridgeError("当前选中设备型号不受支持")
        if not _device_is_connected(device) and not allow_blocked:
            raise DeviceBridgeError("选中设备的蓝牙连接已断开")

        if channel is not None and requested_strength is not None and not allow_blocked:
            channel_name = "channelA" if channel == Channel.A else "channelB"
            safety = _channel_snapshot(device, channel_name)
            props = device.get("props") if isinstance(device.get("props"), dict) else {}
            channel_status_key = "channelAStatus" if channel == Channel.A else "channelBStatus"
            if props.get(channel_status_key) in {3, 4}:
                raise DeviceBridgeError("设备报告通道异常或已屏蔽")
            limit_value = safety.get("limit")
            if limit_value is None:
                raise DeviceBridgeError("App 尚未回传通道安全上限")
            if limit_value <= 0:
                raise DeviceBridgeError("通道已静音、过热或安全上限为 0")
            if requested_strength > limit_value:
                raise DeviceBridgeError("请求强度超过 App 当前安全上限")
        return session, device

    async def _send_request(
        self,
        session: AppSession,
        method: str,
        data: Optional[Dict[str, Any]] = None,
        wait_for_response: bool = True,
        timeout_seconds: float = RPC_TIMEOUT_SECONDS,
    ) -> Any:
        """发送一条 V4 RPC；持续输出不等待结束回执，停止指令必须等待确认。"""

        if session.client_id not in self._sessions:
            raise DeviceBridgeError("DG-LAB App 已断开")
        request_id = f"gb-{secrets.token_hex(8)}"
        request = {
            "t": "req",
            "reqId": request_id,
            "requestId": request_id,
            "m": method,
        }
        if data is not None:
            request["data"] = data

        pending = None
        if wait_for_response:
            future = asyncio.get_running_loop().create_future()
            pending = PendingRequest(client_id=session.client_id, future=future)
            self._pending[request_id] = pending

        try:
            await session.websocket.send(json.dumps({"type": "message", "data": request}))
        except Exception as error:
            self._pending.pop(request_id, None)
            raise DeviceBridgeError(f"向 DG-LAB App 发送指令失败: {error}") from error

        if pending is None:
            return {"request_id": request_id}
        try:
            return await asyncio.wait_for(pending.future, timeout=timeout_seconds)
        except asyncio.TimeoutError as error:
            raise DeviceBridgeError("等待 DG-LAB App 确认指令超时") from error
        finally:
            self._pending.pop(request_id, None)

    def _resolve_response(self, client_id: str, response: Dict[str, Any]) -> None:
        """只允许原目标 App 完成对应请求，避免多 App 回执串线。"""

        request_id = response.get("reqId") or response.get("requestId")
        if not isinstance(request_id, str):
            return
        pending = self._pending.get(request_id)
        if pending is None or pending.client_id != client_id or pending.future.done():
            return
        error = response.get("error")
        if error:
            pending.future.set_exception(DeviceBridgeError(f"DG-LAB App 拒绝指令: {error}"))
        else:
            pending.future.set_result(response.get("result"))

    async def _heartbeat_loop(self, session: AppSession) -> None:
        """按官方 V4 语义发送无需回复的服务器心跳。"""

        try:
            while session.client_id in self._sessions:
                await asyncio.sleep(APP_HEARTBEAT_SECONDS)
                await session.websocket.send(json.dumps({"type": "heartbeat"}))
        except asyncio.CancelledError:
            raise
        except Exception:
            # 主接收循环会负责统一移除连接，心跳任务不单独改共享状态。
            return

    async def _notify_state(self) -> None:
        """把最新设备快照推给主服务；回调失败不能击穿 V4 网络循环。"""

        if self._state_callback is None:
            return
        try:
            await self._state_callback(self.state_snapshot())
        except Exception as error:
            print(f"同步 V4 设备状态失败: {error}")

    async def _reject_connection(self, websocket: Any, code: str, close_code: int = 4001) -> None:
        """用结构化错误拒绝错误二维码、过期 tid 或超过容量的连接。"""

        try:
            await websocket.send(json.dumps({"type": "error", "code": code}))
        except Exception:
            pass
        try:
            await websocket.close(code=close_code, reason=code)
        except Exception:
            pass

    def _new_client_id(self) -> str:
        """生成当前进程内不重复的短客户端 ID。"""

        client_id = secrets.token_hex(4)
        while client_id in self._sessions:
            client_id = secrets.token_hex(4)
        return client_id

    def _reject_pending_for_client(self, client_id: str, error: Exception) -> None:
        """App 断线时立即唤醒等待中的停止或探测请求。"""

        for request_id, pending in list(self._pending.items()):
            if pending.client_id != client_id:
                continue
            self._pending.pop(request_id, None)
            if not pending.future.done():
                pending.future.set_exception(error)

    def _reject_all_pending(self, error: Exception) -> None:
        """桥接关闭时清空所有等待，防止协程和内存残留。"""

        for pending in self._pending.values():
            if not pending.future.done():
                pending.future.set_exception(error)
        self._pending.clear()
