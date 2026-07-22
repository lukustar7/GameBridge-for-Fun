# -*- coding: utf-8 -*-
"""波形时长适配、随机策略和郊狼双协议编码回归测试。"""

import math
import unittest

from coyote_waveforms import (
    DEFAULT_WAVEFORM_KEY,
    LONG_RANDOM_KEYS,
    MEDIUM_RANDOM_KEYS,
    SHORT_RANDOM_KEYS,
    WAVEFORM_PROFILES,
    build_coyote_waveform_frames,
    fit_waveform_points,
    normalize_waveform_key,
    resolve_waveform_key,
)


class WaveformSelectionTests(unittest.TestCase):
    """验证用户只需选感觉，损坏输入和随机细节由程序安全处理。"""

    def test_unknown_mode_falls_back_to_immediate_default(self):
        self.assertEqual(normalize_waveform_key("unknown"), DEFAULT_WAVEFORM_KEY)
        self.assertEqual(normalize_waveform_key({"bad": True}), DEFAULT_WAVEFORM_KEY)

    def test_random_pool_changes_with_duration_and_returns_one_fixed_key(self):
        short = resolve_waveform_key("random", 500, chooser=lambda choices: choices[-1])
        medium = resolve_waveform_key("random", 2000, chooser=lambda choices: choices[-1])
        long = resolve_waveform_key("random", 5000, chooser=lambda choices: choices[-1])

        self.assertEqual(short, SHORT_RANDOM_KEYS[-1])
        self.assertEqual(medium, MEDIUM_RANDOM_KEYS[-1])
        self.assertEqual(long, LONG_RANDOM_KEYS[-1])
        self.assertNotIn("shade", LONG_RANDOM_KEYS)

    def test_bad_random_chooser_cannot_inject_unknown_waveform(self):
        selected = resolve_waveform_key("random", 500, chooser=lambda _choices: "not-supported")

        self.assertEqual(selected, DEFAULT_WAVEFORM_KEY)

    def test_invalid_duration_falls_back_without_crashing(self):
        """内部模块即使收到损坏时长，也必须回到最短安全任务。"""

        selected = resolve_waveform_key("random", None, chooser=lambda choices: choices[0])

        self.assertIn(selected, SHORT_RANDOM_KEYS)
        self.assertEqual(len(fit_waveform_points(DEFAULT_WAVEFORM_KEY, None)), 1)


class WaveformDurationTests(unittest.TestCase):
    """验证短惩罚不会只播放慢波形开头，长惩罚也不会产生无界数据。"""

    def test_default_300ms_is_immediate_and_varies(self):
        points = fit_waveform_points(DEFAULT_WAVEFORM_KEY, 300)

        self.assertEqual(len(points), 3)
        self.assertGreater(points[0][1], 0)
        self.assertGreater(len(set(points)), 1)

    def test_breathing_is_compressed_into_500ms_instead_of_truncated(self):
        points = fit_waveform_points("breathing", 500)
        strengths = [strength for _frequency, strength in points]

        self.assertEqual(len(points), 5)
        self.assertGreater(strengths[0], 0)
        self.assertEqual(max(strengths), 100)
        self.assertGreater(len(set(strengths)), 2)

    def test_duration_rounds_up_to_complete_100ms_frame(self):
        self.assertEqual(len(fit_waveform_points(DEFAULT_WAVEFORM_KEY, 101)), 2)
        self.assertEqual(len(fit_waveform_points(DEFAULT_WAVEFORM_KEY, 599)), 6)

    def test_maximum_duration_is_bounded_to_600_frames(self):
        self.assertEqual(len(fit_waveform_points("pulse", 999999)), 600)


class WaveformEncodingTests(unittest.TestCase):
    """穷举全部预设，锁定 V2/V3 帧长度和协议数值边界。"""

    def test_all_profiles_generate_legal_v2_and_v3_frames(self):
        for key in WAVEFORM_PROFILES:
            with self.subTest(key=key, device="2.0"):
                version, frames = build_coyote_waveform_frames("COYOTE_020", key, 1300)
                self.assertEqual(version, 2)
                self.assertEqual(len(frames), 13)
                for frame in frames:
                    self.assertEqual(len(frame), 3)
                    packed = frame[0] | (frame[1] << 8) | (frame[2] << 16)
                    self.assertLessEqual(packed & 0x1F, 31)
                    self.assertLessEqual((packed >> 5) & 0x3FF, 1023)
                    self.assertLessEqual((packed >> 15) & 0x1F, 20)

            with self.subTest(key=key, device="3.0"):
                version, frames = build_coyote_waveform_frames("COYOTE_030", key, 1300)
                self.assertEqual(version, 3)
                self.assertEqual(len(frames), 13)
                for frame in frames:
                    self.assertEqual(len(frame), 8)
                    self.assertTrue(all(10 <= value <= 240 for value in frame[:4]))
                    self.assertTrue(all(0 <= value <= 100 for value in frame[4:]))

    def test_v2_frequency_decompression_uses_public_piecewise_mapping(self):
        _version, frames = build_coyote_waveform_frames("COYOTE_020", "pulse", 1600)
        last = frames[-1]
        packed = last[0] | (last[1] << 8) | (last[2] << 16)
        x_value = packed & 0x1F
        y_value = (packed >> 5) & 0x3FF

        # V3 编码 160 对应 V2 周期 400ms，不能被错误地直接当成 160ms。
        self.assertEqual(x_value + y_value, 400)
        self.assertEqual(x_value, int(math.sqrt(0.4) * 15))

    def test_unknown_hardware_fails_closed(self):
        with self.assertRaises(ValueError):
            build_coyote_waveform_frames("COYOTE_FUTURE", DEFAULT_WAVEFORM_KEY, 500)


if __name__ == "__main__":
    unittest.main()
