# -*- coding: utf-8 -*-
"""郊狼经典波形、短时长适配与 V2/V3 编码。

本模块只处理“什么感觉”，不处理通道强度。用户设置的通道强度继续由 App
安全上限和服务端限幅控制；波形中的 0～100 只表示一个周期内部的相对起伏。
"""

import math
import secrets
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional, Sequence, Tuple


DEFAULT_WAVEFORM_KEY = "game_default"
RANDOM_WAVEFORM_KEY = "random"
MAX_WAVEFORM_DURATION_MS = 60000


@dataclass(frozen=True)
class WaveformProfile:
    """一组每 100ms 更新一次的“频率编码值、相对波形强度”。"""

    key: str
    label: str
    points: Tuple[Tuple[int, int], ...]


def _alternating_points(repeats: int) -> Tuple[Tuple[int, int], ...]:
    """生成快速按捏的开关节奏；末尾补零，让完整长周期自然收尾。"""

    return tuple([(10, 0), (10, 100)] * repeats + [(10, 0)])


def _clamp_duration_ms(value: object) -> int:
    """把内部调用的异常时长安全压回协议范围，避免独立模块被误用时崩溃。"""

    try:
        duration = int(value)
    except (TypeError, ValueError, OverflowError):
        duration = 100
    return max(100, min(MAX_WAVEFORM_DURATION_MS, duration))


# 经典预设以公开协议中的频率和相对强度重新表达，不把官方 SDK 作为运行依赖。
# 这样 macOS 仍只需要 Python 3.9+ 与项目现有的 websockets 12.0。
WAVEFORM_PROFILES: Dict[str, WaveformProfile] = {
    DEFAULT_WAVEFORM_KEY: WaveformProfile(
        DEFAULT_WAVEFORM_KEY,
        "游戏默认",
        # 第一帧已经有效，0.1～1 秒的短惩罚也不会浪费在无感的慢启动上。
        ((10, 55), (10, 100), (14, 72), (20, 92), (10, 60)),
    ),
    "extrusion": WaveformProfile("extrusion", "挤压", ((10, 0), (10, 100))),
    "bubble": WaveformProfile("bubble", "气泡", ((45, 0), (45, 100))),
    "rhythm": WaveformProfile(
        "rhythm",
        "律动",
        (
            (10, 0), (10, 50), (10, 100), (10, 0), (10, 50), (10, 100),
            (25, 100), (29, 100), (34, 100), (38, 100), (43, 100), (10, 0), (10, 0),
        ),
    ),
    "air_waves": WaveformProfile(
        "air_waves",
        "电波",
        (
            (10, 100), (23, 100), (36, 100), (50, 100), (10, 0),
            (10, 100), (10, 0), (10, 100), (10, 0), (10, 100),
            (10, 0), (10, 100), (10, 0),
        ),
    ),
    "dance": WaveformProfile(
        "dance",
        "舞步",
        (
            (10, 0), (10, 0), (10, 100), (10, 0), (10, 0), (10, 100),
            (10, 0), (10, 0), (10, 100), (10, 100), (10, 100), (10, 0),
            (10, 0), (10, 100), (10, 100), (10, 100),
        ),
    ),
    "climb": WaveformProfile(
        "climb",
        "攀登",
        ((48, 50), (40, 60), (32, 70), (25, 80), (17, 90), (10, 100)),
    ),
    "shade": WaveformProfile("shade", "树荫", ((100, 100), (100, 100))),
    "pulse": WaveformProfile(
        "pulse",
        "脉冲",
        tuple(
            (frequency, 100)
            for frequency in (
                10, 13, 16, 19, 22, 28, 37, 46,
                55, 64, 78, 108, 121, 134, 147, 160,
            )
        ),
    ),
    "breathing": WaveformProfile(
        "breathing",
        "呼吸",
        tuple((10, strength) for strength in (0, 20, 40, 60, 80, 100, 100, 100, 0, 0, 0, 0)),
    ),
    "tide": WaveformProfile(
        "tide",
        "潮汐",
        (
            (10, 0), (11, 16), (13, 33), (14, 50), (16, 66), (18, 83),
            (19, 100), (21, 92), (22, 84), (24, 76), (26, 68), (26, 0),
            (27, 16), (29, 33), (30, 50), (32, 66), (34, 83), (35, 100),
            (37, 92), (38, 84), (40, 76), (42, 68), (10, 0),
        ),
    ),
    "pulsating": WaveformProfile(
        "pulsating",
        "连击",
        tuple((10, strength) for strength in (100, 0, 100, 66, 33, 0, 0, 0) * 3),
    ),
    "quick_rub": WaveformProfile("quick_rub", "快速按捏", _alternating_points(23)),
    "gradual_rub": WaveformProfile(
        "gradual_rub",
        "按捏渐强",
        tuple(
            (10, strength)
            for strength in (
                0, 28, 0, 52, 0, 73, 0, 87, 0, 100, 0,
                0, 28, 0, 52, 0, 73, 0, 87, 0, 100, 0, 0,
            )
        ),
    ),
    "heartbeat": WaveformProfile(
        "heartbeat",
        "心跳节奏",
        tuple(
            (frequency, strength)
            for frequency, strength in (
                [(112, 100)] * 6
                + [(10, 0)] * 5
                + [(10, 75), (10, 83), (10, 91), (10, 100)]
                + [(10, 0)] * 9
                + [(10, 75), (10, 83), (10, 91), (10, 100)]
                + [(10, 0)] * 6
            )
        ),
    ),
    "compress": WaveformProfile(
        "compress",
        "压缩",
        tuple(
            (frequency, 100)
            for frequency in (74, 69, 64, 59, 54, 50, 45, 40, 35, 30, 26)
            + (10,) * 10
        ),
    ),
    "rhythmic": WaveformProfile(
        "rhythmic",
        "节奏步伐",
        tuple(
            (10, strength)
            for strength in (
                0, 20, 40, 60, 80, 100,
                0, 25, 50, 75, 100,
                0, 33, 66, 100,
                0, 50, 100,
                0, 100, 0, 100, 0, 100, 0, 100, 0,
            )
        ),
    ),
}


# 随机模式故意不包含持续满幅的“树荫”。短惩罚也只从立即能形成节奏的集合抽取，
# 避免用户选择随机后又遇到长时间静默开头。
SHORT_RANDOM_KEYS = ("extrusion", "bubble", "climb", "pulsating", "quick_rub", "rhythmic")
MEDIUM_RANDOM_KEYS = SHORT_RANDOM_KEYS + ("rhythm", "air_waves", "dance", "breathing", "gradual_rub")
LONG_RANDOM_KEYS = MEDIUM_RANDOM_KEYS + ("tide", "heartbeat", "compress", "pulse")


def normalize_waveform_key(value: object) -> str:
    """只接受页面公开的模式；损坏缓存和伪造请求统一回退到游戏默认。"""

    if not isinstance(value, str):
        return DEFAULT_WAVEFORM_KEY
    normalized = value.strip().lower()
    if normalized == RANDOM_WAVEFORM_KEY or normalized in WAVEFORM_PROFILES:
        return normalized
    return DEFAULT_WAVEFORM_KEY


def waveform_label(value: object) -> str:
    """返回面向用户的简短名称，不向界面泄露协议字段。"""

    key = normalize_waveform_key(value)
    if key == RANDOM_WAVEFORM_KEY:
        return "随机"
    return WAVEFORM_PROFILES[key].label


def resolve_waveform_key(
    value: object,
    duration_ms: int,
    chooser: Optional[Callable[[Sequence[str]], str]] = None,
) -> str:
    """把随机模式按本次时长解析成一个固定预设，保证 A/B 同次输出一致。"""

    key = normalize_waveform_key(value)
    if key != RANDOM_WAVEFORM_KEY:
        return key

    safe_duration = _clamp_duration_ms(duration_ms)
    if safe_duration <= 1000:
        choices = SHORT_RANDOM_KEYS
    elif safe_duration <= 3000:
        choices = MEDIUM_RANDOM_KEYS
    else:
        choices = LONG_RANDOM_KEYS
    choose = chooser or secrets.choice
    selected = choose(choices)
    return selected if selected in choices else DEFAULT_WAVEFORM_KEY


def _rotate_short_waveform(points: Sequence[Tuple[int, int]]) -> List[Tuple[int, int]]:
    """短输出从首个有效点开始，避免 0.5 秒全部耗在预设的前置静默。"""

    for index, (_frequency, strength) in enumerate(points):
        if strength > 0:
            return list(points[index:]) + list(points[:index])
    return list(points)


def fit_waveform_points(waveform_key: str, duration_ms: int) -> List[Tuple[int, int]]:
    """按本次时长压缩或循环预设，并生成精确到 100ms 的帧数量。"""

    key = waveform_key if waveform_key in WAVEFORM_PROFILES else DEFAULT_WAVEFORM_KEY
    safe_duration = _clamp_duration_ms(duration_ms)
    frame_count = max(1, math.ceil(safe_duration / 100))
    source = list(WAVEFORM_PROFILES[key].points)

    if frame_count <= 10:
        source = _rotate_short_waveform(source)

    if frame_count < len(source):
        # 以区段最高点压缩完整周期，比单纯截取前 N 帧更能保留短时波形的主要触感。
        compressed = []
        for frame_index in range(frame_count):
            start = math.floor(frame_index * len(source) / frame_count)
            end = max(start + 1, math.floor((frame_index + 1) * len(source) / frame_count))
            segment = source[start:end]
            compressed.append(max(segment, key=lambda point: point[1]))
        return compressed

    return [source[index % len(source)] for index in range(frame_count)]


def _decode_v3_frequency(encoded_frequency: int) -> int:
    """把 V3 压缩频率还原成 V2 使用的毫秒周期。"""

    value = max(10, min(240, int(encoded_frequency)))
    if value <= 100:
        return value
    if value <= 200:
        return 100 + (value - 100) * 5
    return 600 + (value - 200) * 10


def _encode_v2_frame(frequency: int, strength: int) -> List[int]:
    """按公开 X/Y/Z 公式生成一个小端三字节 V2 帧。"""

    period = _decode_v3_frequency(frequency)
    pulse_x = max(1, min(31, int(math.sqrt(period / 1000) * 15)))
    pause_y = max(0, min(1023, period - pulse_x))
    # 官方 V2 App 的相对波形强度上限为 20；向下取整与公开转换示例一致。
    wave_z = max(0, min(20, int(max(0, min(100, strength)) / 5)))
    packed = pulse_x | (pause_y << 5) | (wave_z << 15)
    return [packed & 0xFF, (packed >> 8) & 0xFF, (packed >> 16) & 0xFF]


def build_coyote_waveform_frames(
    device_type: str,
    waveform_key: str,
    duration_ms: int,
) -> Tuple[int, List[List[int]]]:
    """为当前硬件生成完整帧序列；未知型号必须失败，不能猜协议后试发。"""

    points = fit_waveform_points(waveform_key, duration_ms)
    if device_type == "COYOTE_020":
        return 2, [_encode_v2_frame(frequency, strength) for frequency, strength in points]
    if device_type == "COYOTE_030":
        frames = []
        for frequency, strength in points:
            safe_frequency = max(10, min(240, int(frequency)))
            safe_strength = max(0, min(100, int(strength)))
            frames.append([safe_frequency] * 4 + [safe_strength] * 4)
        return 3, frames
    raise ValueError("当前设备型号没有已验证的郊狼波形适配器")
