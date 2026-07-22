# -*- coding: utf-8 -*-
"""关键界面结构与安全入口的静态回归测试。"""

from html.parser import HTMLParser
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]


class InterfaceHTMLParser(HTMLParser):
    """收集原生 HTML 元素，避免用正则表达式误判嵌套结构。"""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.ids = []
        self.elements = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        self.elements.append((tag, attributes))
        element_id = attributes.get("id")
        if element_id:
            self.ids.append(element_id)


def parse_html(path):
    """读取并解析指定界面文件。"""

    parser = InterfaceHTMLParser()
    parser.feed(path.read_text(encoding="utf-8"))
    parser.close()
    return parser


class InterfaceStructureTests(unittest.TestCase):
    """锁定本轮界面重构中最容易被后续修改破坏的交互骨架。"""

    @classmethod
    def setUpClass(cls):
        cls.game_path = ROOT / "static" / "game.html"
        cls.console_path = ROOT / "static" / "index.html"
        cls.game_text = cls.game_path.read_text(encoding="utf-8")
        cls.console_text = cls.console_path.read_text(encoding="utf-8")
        cls.game_script_text = (ROOT / "static" / "game.js").read_text(encoding="utf-8")
        cls.game = parse_html(cls.game_path)
        cls.console = parse_html(cls.console_path)

    def test_pages_do_not_contain_duplicate_ids(self):
        """重复 id 会让按钮或状态文字更新到错误区域，必须在提交前拦截。"""

        for path, parser in ((self.game_path, self.game), (self.console_path, self.console)):
            with self.subTest(path=path.name):
                duplicates = sorted({item for item in parser.ids if parser.ids.count(item) > 1})
                self.assertEqual(duplicates, [])

    def test_game_has_persistent_emergency_stop_and_short_settings_flow(self):
        """选择、设置和游玩三页都共享紧急停止入口，设置页保留固定操作栏。"""

        self.assertIn('id="global-safety-bar"', self.game_text)
        self.assertIn('onclick="stopMobileOutput()"', self.game_text)
        self.assertIn('class="settings-sticky-actions"', self.game_text)
        self.assertIn('onclick="resetSelectedSettings()"', self.game_text)
        self.assertIn('id="screen-settings" class="screen" hidden', self.game_text)
        self.assertIn('id="screen-play" class="screen" hidden', self.game_text)

    def test_waveform_choice_is_one_global_control_and_test_uses_safe_default(self):
        """新增感觉不能散落到四个游戏；试电也必须显式走立即有感的默认波形。"""

        waveform_selects = [
            attrs
            for tag, attrs in self.game.elements
            if tag == "select" and attrs.get("id") == "common-waveform"
        ]
        waveform_values = {
            attrs.get("value")
            for tag, attrs in self.game.elements
            if tag == "option" and attrs.get("value")
        }

        self.assertEqual(len(waveform_selects), 1)
        self.assertIn("game_default", waveform_values)
        self.assertIn("random", waveform_values)
        self.assertIn("breathing", waveform_values)
        self.assertIn("pulse", waveform_values)
        self.assertIn("所有玩法共用", self.game_script_text)
        self.assertIn("固定使用强度 15", self.game_text)
        self.assertIn("const MOBILE_TEST_STRENGTH = 15;", self.game_script_text)

        test_start = self.game_script_text.index("function sendMobileTestShock(outputMode) {")
        test_end = self.game_script_text.index("function stopMobileOutput() {", test_start)
        self.assertIn("waveform: DEFAULT_WAVEFORM", self.game_script_text[test_start:test_end])
        self.assertIn("strength: MOBILE_TEST_STRENGTH", self.game_script_text[test_start:test_end])

        console_strength = [
            attrs
            for tag, attrs in self.console.elements
            if tag == "input" and attrs.get("id") == "console-test-strength"
        ]
        self.assertEqual(len(console_strength), 1)
        self.assertEqual(console_strength[0].get("value"), "15")
        self.assertEqual(console_strength[0].get("max"), "30")

    def test_mobile_emergency_stop_cancels_local_queues_before_another_game_can_start(self):
        """手机急停不能只清当前硬件帧，还必须退出本局并取消骰子、角子机等预约任务。"""

        function_start = self.game_script_text.index("function stopMobileOutput() {")
        function_end = self.game_script_text.index("function closeGameSocketForEmergency()", function_start)
        function_body = self.game_script_text[function_start:function_end]

        self.assertIn("exitGame();", function_body)
        self.assertNotIn('sendGameMessage({ type: "stop_shock" })', function_body)

    def test_each_game_has_one_default_open_basic_group(self):
        """每种玩法首次进入只展开一个基础分组，避免重新退化成长滚动页。"""

        details = [
            attrs
            for tag, attrs in self.game.elements
            if tag == "details" and "settings-group" in attrs.get("class", "").split()
        ]
        for game in ("shake", "angle", "dice", "slot"):
            with self.subTest(game=game):
                defaults = [
                    attrs
                    for attrs in details
                    if attrs.get("data-game") == game and attrs.get("data-default-open") == "true"
                ]
                self.assertEqual(len(defaults), 1)

    def test_slot_special_event_copy_and_symbols_are_unambiguous(self):
        """界面只能把三个 7️⃣ 图标称为特殊事件，图标池不得再混入自带 777 的老虎机图标。"""

        symbols_line = next(
            line for line in self.game_script_text.splitlines() if line.startswith("const SLOT_SYMBOLS =")
        )
        self.assertIn("7️⃣", symbols_line)
        self.assertIn("🍀", symbols_line)
        self.assertNotIn("🎰", symbols_line)
        self.assertIn("三个图标全是 7️⃣ 时", self.game_text)
        self.assertIn("进入满槽：本局不输出", self.game_text)
        self.assertNotIn("三轮", self.game_text)
        self.assertNotIn("立即最大惩罚", self.game_text)

    def test_console_uses_accessible_tabs_and_persistent_stop(self):
        """桌面控制台的页签应支持读屏语义，停止按钮不能藏在某个页签内。"""

        self.assertIn('role="tablist"', self.console_text)
        self.assertEqual(self.console_text.count('role="tab"'), 3)
        self.assertEqual(self.console_text.count('role="tabpanel"'), 3)
        emergency_buttons = [
            attrs
            for tag, attrs in self.console.elements
            if tag == "button" and "console-emergency-stop" in attrs.get("class", "").split()
        ]
        self.assertEqual(len(emergency_buttons), 1)
        self.assertNotIn("$\\leftrightarrow$", self.console_text)

    def test_android_toolbar_exposes_native_stop_action(self):
        """APK 隐藏网页标题后，原生工具栏仍必须提供随时可见的停止输出按钮。"""

        layout = ET.parse(ROOT / "android" / "app" / "src" / "main" / "res" / "layout" / "activity_main.xml")
        menu = ET.parse(ROOT / "android" / "app" / "src" / "main" / "res" / "menu" / "game_toolbar.xml")
        android_namespace = "{http://schemas.android.com/apk/res/android}"
        app_namespace = "{http://schemas.android.com/apk/res-auto}"

        toolbar = next(element for element in layout.iter() if element.tag.endswith("MaterialToolbar"))
        self.assertEqual(toolbar.attrib.get(f"{app_namespace}menu"), "@menu/game_toolbar")

        item = next(element for element in menu.iter() if element.tag == "item")
        self.assertEqual(item.attrib.get(f"{android_namespace}id"), "@+id/actionStopOutput")
        self.assertEqual(item.attrib.get(f"{app_namespace}showAsAction"), "always")


if __name__ == "__main__":
    unittest.main()
