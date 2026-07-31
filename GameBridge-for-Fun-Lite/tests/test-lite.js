"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const liteRoot = path.resolve(__dirname, "..");
const projectRoot = path.resolve(liteRoot, "..");
const protocol = require(path.join(liteRoot, "js/coyote-protocol.js"));
const waveforms = require(path.join(liteRoot, "js/waveforms.js"));
const outputApi = require(path.join(liteRoot, "js/output-controller.js"));
const driverApi = require(path.join(liteRoot, "js/ble-driver.js"));

function testProtocolEncoding() {
    const strength = protocol.encodeV2Strength(16, 25);
    const packed = strength[0] | (strength[1] << 8) | (strength[2] << 16);
    assert.equal((packed >>> 11) & 0x7ff, 16 * 7, "V2 A 通道强度必须放在高 11 位");
    assert.equal(packed & 0x7ff, 25 * 7, "V2 B 通道强度必须放在低 11 位");

    const frame = protocol.encodeV3Frame({
        sequence: 9,
        strengthA: 30,
        strengthB: 0,
        point: [45, 80]
    });
    assert.equal(frame.length, 20, "V3 B0 帧必须固定为 20 字节");
    assert.equal(frame[0], 0xb0);
    assert.equal(frame[1], 0x9f, "V3 必须使用绝对 A+B 强度模式");
    assert.equal(frame[2], 30);
    assert.equal(frame[3], 0);
    assert.deepEqual(Array.from(frame.slice(4, 12)), [45, 45, 45, 45, 80, 80, 80, 80]);
    assert.deepEqual(Array.from(frame.slice(12, 20)), [10, 10, 10, 10, 101, 101, 101, 101]);

    const notificationBuffer = new Uint8Array([0, 0, 0xb1, 7, 18, 19, 0]).buffer;
    assert.deepEqual(
        protocol.parseV3Notification(new DataView(notificationBuffer, 2, 4)),
        { sequence: 7, strengthA: 18, strengthB: 19 },
        "V3 通知必须尊重 DataView 偏移"
    );

    assert.deepEqual(
        protocol.channelStrengths(80, "ab", 15, 20),
        { a: 15, b: 20 },
        "最终出口必须同时受两个用户上限约束"
    );
    assert.deepEqual(
        protocol.channelStrengths(80, "ab", 200, 200, "percent", 50),
        { a: 80, b: 40 },
        "A+B 按比例模式必须与原版一样降低 B 通道强度"
    );
    assert.deepEqual(
        protocol.channelStrengths(80, "b", 200, 200, "same", 10),
        { a: 0, b: 80 },
        "B 同强度模式不得错误套用比例"
    );
}

function testWaveformAdaptation() {
    assert.equal(waveforms.listOptions().length, 18, "必须提供 17 个固定波形和 1 个随机模式");
    const shortDefault = waveforms.fitPoints("game_default", 500, 0);
    assert.equal(shortDefault.length, 5);
    assert.ok(shortDefault[0][1] > 0, "短输出第一帧必须立即有效");

    const shortRandom = waveforms.resolveKey("random", 1000, 0);
    assert.equal(shortRandom, "extrusion", "随机选择必须可以被确定性测试");
    assert.notEqual(waveforms.resolveKey("random", 1000, 0.999), "shade", "短随机不得选择持续满幅预设");
    assert.equal(waveforms.fitPoints("missing", 1000).length, 10, "非法波形必须回退且保持时长");
}

async function testSerializedOutputAndDurationFloor() {
    let activeWrites = 0;
    let maximumConcurrentWrites = 0;
    const writes = [];
    let stops = 0;
    const driver = {
        connected: true,
        async writeFrame(frame) {
            activeWrites += 1;
            maximumConcurrentWrites = Math.max(maximumConcurrentWrites, activeWrites);
            await Promise.resolve();
            writes.push(frame);
            activeWrites -= 1;
        },
        async stop() {
            stops += 1;
        }
    };
    const controller = new outputApi.OutputController(driver);
    controller.configure({ channel: "ab", limitA: 15, limitB: 20, waveform: "game_default" });

    const realSetTimeout = global.setTimeout;
    const realClearTimeout = global.clearTimeout;
    global.setTimeout = function (callback) {
        queueMicrotask(callback);
        return 1;
    };
    global.clearTimeout = function () {};
    try {
        await controller.playPulse(100, 200, "测试");
    } finally {
        global.setTimeout = realSetTimeout;
        global.clearTimeout = realClearTimeout;
    }

    assert.equal(writes.length, 10, "所有单次输出都必须至少持续 1 秒");
    assert.equal(maximumConcurrentWrites, 1, "蓝牙写入不得并发堆积");
    assert.ok(writes.every((frame) => frame.strengthA === 15 && frame.strengthB === 20));
    assert.ok(stops >= 2, "开始前和结束后都必须发送归零");
}

async function testSlowBluetoothCannotExtendFinitePulse() {
    const writes = [];
    const driver = {
        connected: true,
        async writeFrame(frame) {
            writes.push(frame);
        },
        async stop() {}
    };
    const controller = new outputApi.OutputController(driver);
    controller.configure({ channel: "a", limitA: 30, limitB: 0, waveform: "game_default" });
    const realNow = Date.now;
    const realSetTimeout = global.setTimeout;
    const realClearTimeout = global.clearTimeout;
    let clock = 0;
    Date.now = function () {
        clock += 600;
        return clock;
    };
    global.setTimeout = function (callback) {
        queueMicrotask(callback);
        return 1;
    };
    global.clearTimeout = function () {};
    try {
        await controller.playPulse(30, 1000, "慢写入测试");
    } finally {
        Date.now = realNow;
        global.setTimeout = realSetTimeout;
        global.clearTimeout = realClearTimeout;
    }
    assert.equal(writes.length, 1, "到达墙钟截止时间后不得补发积压波形帧");
}

function createFakeCharacteristic() {
    return {
        writes: [],
        listeners: new Map(),
        async writeValueWithoutResponse(bytes) {
            this.writes.push(Array.from(bytes));
        },
        async startNotifications() {
            return this;
        },
        addEventListener(name, callback) {
            this.listeners.set(name, callback);
        },
        removeEventListener(name) {
            this.listeners.delete(name);
        }
    };
}

function createFakeDevice(serviceByUuid) {
    const listeners = new Map();
    const server = {
        async getPrimaryService(uuid) {
            if (!serviceByUuid[uuid]) {
                throw new Error("服务不存在");
            }
            return serviceByUuid[uuid];
        }
    };
    const device = {
        name: "测试设备",
        listeners,
        addEventListener(name, callback) {
            listeners.set(name, callback);
        },
        removeEventListener(name) {
            listeners.delete(name);
        },
        gatt: {
            connected: false,
            async connect() {
                this.connected = true;
                return server;
            },
            disconnect() {
                this.connected = false;
            }
        }
    };
    return device;
}

async function testBleProtocolDiscovery() {
    const v2Strength = createFakeCharacteristic();
    const v2WaveA = createFakeCharacteristic();
    const v2WaveB = createFakeCharacteristic();
    const v2Service = {
        async getCharacteristic(uuid) {
            return {
                [protocol.UUIDS.v2.strength]: v2Strength,
                [protocol.UUIDS.v2.waveA]: v2WaveA,
                [protocol.UUIDS.v2.waveB]: v2WaveB
            }[uuid];
        }
    };
    const v2Device = createFakeDevice({ [protocol.UUIDS.v2.service]: v2Service });
    const v2Driver = new driverApi.BleDriver();
    await v2Driver.connect({ bluetooth: { requestDevice: async () => v2Device } });
    assert.equal(v2Driver.protocolVersion, "2.0");
    await v2Driver.writeFrame({ strengthA: 12, strengthB: 0, point: [10, 100] });
    assert.equal(v2Strength.writes.length, 2, "V2 连接归零和测试帧都必须写强度");
    assert.equal(v2WaveA.writes.length, 2);
    assert.equal(v2WaveB.writes.length, 2);
    await v2Driver.disconnect();

    const v3Write = createFakeCharacteristic();
    const v3Notify = createFakeCharacteristic();
    const v3Service = {
        async getCharacteristic(uuid) {
            return uuid === protocol.UUIDS.v3.write ? v3Write : v3Notify;
        }
    };
    const v3Device = createFakeDevice({ [protocol.UUIDS.v3.service]: v3Service });
    const v3Driver = new driverApi.BleDriver();
    await v3Driver.connect({ bluetooth: { requestDevice: async () => v3Device } });
    assert.equal(v3Driver.protocolVersion, "3.0");
    await v3Driver.writeFrame({ strengthA: 9, strengthB: 7, point: [45, 80] });
    assert.equal(v3Write.writes.length, 2);
    assert.ok(v3Write.writes.every((bytes) => bytes.length === 20));
    await v3Driver.disconnect();

    const unknownDevice = createFakeDevice({});
    const unknownDriver = new driverApi.BleDriver();
    await assert.rejects(
        unknownDriver.connect({ bluetooth: { requestDevice: async () => unknownDevice } }),
        /不是已支持/
    );
    assert.equal(unknownDevice.gatt.connected, false, "协议识别失败后不得留下空闲 GATT 连接");
}

function testIndependentRuleCopy() {
    const original = fs.readFileSync(path.join(projectRoot, "static/game-logic.js"), "utf8");
    const copied = fs.readFileSync(path.join(liteRoot, "js/game-logic.js"), "utf8");
    assert.equal(copied, original, "Lite 的规则快照必须与当前原版一致，但运行时不得跨目录引用");
}

function extractObjectConstant(source, constantName) {
    const marker = `const ${constantName} =`;
    const markerIndex = source.indexOf(marker);
    assert.ok(markerIndex >= 0, `原版缺少 ${constantName}`);
    const start = source.indexOf("{", markerIndex + marker.length);
    let depth = 0;
    let quote = null;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
        const character = source[index];
        if (quote) {
            if (escaped) {
                escaped = false;
            } else if (character === "\\") {
                escaped = true;
            } else if (character === quote) {
                quote = null;
            }
            continue;
        }
        if (["\"", "'", "`"].includes(character)) {
            quote = character;
        } else if (character === "{") {
            depth += 1;
        } else if (character === "}") {
            depth -= 1;
            if (depth === 0) {
                return source.slice(start, index + 1);
            }
        }
    }
    throw new Error(`${constantName} 对象没有正确结束`);
}

function testGameConfigurationMatchesOriginal() {
    const configPath = path.join(liteRoot, "js/game-config.js");
    assert.ok(fs.existsSync(configPath), "Lite 必须用独立配置模块完整保存原版玩法参数契约");
    const config = require(configPath);
    const originalSource = fs.readFileSync(path.join(projectRoot, "static/game.js"), "utf8");
    const originalDefaults = JSON.parse(JSON.stringify(vm.runInNewContext(
        `(${extractObjectConstant(originalSource, "DEFAULT_SETTINGS")})`
    )));
    const originalOutput = JSON.parse(JSON.stringify(vm.runInNewContext(
        `(${extractObjectConstant(originalSource, "DEFAULT_OUTPUT_SETTINGS")})`
    )));

    assert.deepEqual(config.DEFAULT_SETTINGS, originalDefaults, "五个玩法的字段和默认值必须与原版一致");
    assert.deepEqual(config.DEFAULT_OUTPUT_SETTINGS, originalOutput, "A/B 输出模式和比例默认值必须与原版一致");
    assert.deepEqual(
        Object.fromEntries(Object.entries(config.SETTING_GROUPS).map(([game, groups]) => [
            game,
            groups.flatMap((group) => group.fields.map((field) => field.key)).sort()
        ])),
        Object.fromEntries(Object.entries(originalDefaults).map(([game, defaults]) => [
            game,
            Object.keys(defaults).sort()
        ])),
        "每个原版参数都必须在 Lite 设置页出现一次，不能缺失、改名或多出另一套规则"
    );
    Object.values(config.SETTING_GROUPS).flat().flatMap((group) => group.fields).forEach((field) => {
        assert.ok(field.help && field.help.length >= 8, `${field.key} 必须有面向用户的说明`);
    });

    const hostile = config.cloneDefaultSettings();
    hostile.shake.strengthMin = -500;
    hostile.shake.strengthMax = 999;
    hostile.dice.singleSeconds = 999;
    hostile.slot.winRate = "always-win";
    hostile.lightning.jamGapMinSeconds = 60;
    hostile.lightning.jamGapMaxSeconds = 5;
    const normalized = config.normalizeSettings(hostile);
    assert.equal(normalized.shake.strengthMin, 0);
    assert.equal(normalized.shake.strengthMax, 200);
    assert.equal(normalized.dice.singleSeconds, 30);
    assert.equal(normalized.slot.winRate, config.DEFAULT_SETTINGS.slot.winRate);
    assert.equal(normalized.lightning.jamGapMaxSeconds, 65, "随机间隔上限必须始终高于下限至少 5 秒");
}

function testRequiredFiles() {
    [
        "README.md",
        "USER_GUIDE.md",
        "CHANGELOG.md",
        "VERSION",
        "index.html",
        "manifest.json",
        "sw.js",
        "css/style.css",
        "js/main.js",
        "js/game-config.js",
        "js/game-runtime.js",
        "js/ble-driver.js",
        "js/coyote-protocol.js",
        "js/output-controller.js",
        "js/pwa-manager.js",
        "js/waveforms.js"
    ].forEach((relativePath) => {
        assert.ok(fs.existsSync(path.join(liteRoot, relativePath)), `缺少 Lite 文件：${relativePath}`);
    });

    const html = fs.readFileSync(path.join(liteRoot, "index.html"), "utf8");
    const worker = fs.readFileSync(path.join(liteRoot, "sw.js"), "utf8");
    assert.ok(!html.includes("../"), "Lite 页面不得加载父目录运行文件");
    assert.ok(!worker.includes("../"), "Lite 离线缓存不得访问父目录运行文件");

    const version = fs.readFileSync(path.join(liteRoot, "VERSION"), "utf8").trim();
    assert.match(version, /^\d+\.\d+\.\d+-(alpha|beta)\.\d+$/);
    assert.ok(html.includes(version), "页面版本必须与 VERSION 一致");
    assert.ok(worker.includes(version), "缓存版本必须与 VERSION 一致");

    const manifest = JSON.parse(fs.readFileSync(path.join(liteRoot, "manifest.json"), "utf8"));
    assert.equal(manifest.start_url, "./");
    assert.equal(manifest.scope, "./");
    assert.equal(manifest.display, "standalone");
}

function testDeploymentPathAndDirectControlConfirmation() {
    const publicUrl = "https://lukustar7.github.io/GameBridge-for-Fun/GameBridge-for-Fun-Lite/";
    const rootReadme = fs.readFileSync(path.join(projectRoot, "README.md"), "utf8");
    const liteReadme = fs.readFileSync(path.join(liteRoot, "README.md"), "utf8");
    const html = fs.readFileSync(path.join(liteRoot, "index.html"), "utf8");

    assert.ok(rootReadme.includes(publicUrl), "根 README 必须指向实际部署的 Lite 子目录");
    assert.ok(liteReadme.includes(publicUrl), "Lite README 必须指向实际部署的 Lite 子目录");
    assert.ok(!html.includes("硬件侧设置安全限幅"), "直连版不能要求用户确认并不存在的硬件侧限幅设置");
    assert.ok(html.includes("网页 A/B 安全上限"), "直连版必须明确由当前网页承担 A/B 限幅");
    assert.ok(!liteReadme.includes("GitHub Actions"), "当前分支 Pages 部署说明不得误导用户切换发布源");
}

function testGlobalOutputControlsMatchOriginal() {
    const html = fs.readFileSync(path.join(liteRoot, "index.html"), "utf8");
    const mainSource = fs.readFileSync(path.join(liteRoot, "js/main.js"), "utf8");
    assert.ok(html.includes('id="b-strength-mode"'), "Lite 必须提供原版的 B 通道同强度/按比例设置");
    assert.ok(html.includes('id="b-strength-percent"'), "Lite 必须提供原版的 B 通道比例滑块");
    assert.ok(html.indexOf("./js/game-config.js") < html.indexOf("./js/main.js"), "玩法契约必须先于主程序加载");
    assert.ok(mainSource.includes("window.LiteGameConfig"), "主程序必须使用通过对照测试的独立玩法契约");
}

function testGameSettingsExperienceMatchesOriginal() {
    const html = fs.readFileSync(path.join(liteRoot, "index.html"), "utf8");
    const mainSource = fs.readFileSync(path.join(liteRoot, "js/main.js"), "utf8");
    assert.ok(html.includes('id="restore-game-defaults"'), "每个玩法必须可以单独恢复原版默认值");
    assert.ok(html.includes('id="calibrate-game-pose"'), "方向玩法必须保留原版的手动校准入口");
    assert.ok(mainSource.includes('role", "tablist"'), "长设置页必须使用原版的分组标签结构");
    assert.ok(mainSource.includes("field.help"), "动态生成的每一项参数必须显示解释文字");
    assert.ok(mainSource.includes("SETTING_CATEGORIES"), "设置页分组必须由已核对的玩法契约生成");
    assert.ok(mainSource.includes('gamebridge-lite-settings-v2'), "规则字段变化后必须隔离旧版不兼容的玩法缓存");
    assert.ok(mainSource.includes("schemaVersion: 2"), "本地设置必须带有可审计的结构版本");
    assert.ok(html.includes('id="capability-wake"'), "全局能力中心必须保留屏幕常亮检查");
    assert.ok(html.includes('id="capability-vibration"'), "全局能力中心必须保留本机震动检查");
    ["a", "b", "ab"].forEach((mode) => {
        assert.ok(html.includes(`data-test-channel="${mode}"`), `低强度试电必须保留原版的 ${mode.toUpperCase()} 独立入口`);
    });
}

function testRuntimeRuleParity() {
    const runtimePath = path.join(liteRoot, "js/game-runtime.js");
    assert.ok(fs.existsSync(runtimePath), "传感器与随机玩法必须使用可独立测试的运行规则模块");
    const runtime = require(runtimePath);

    assert.deepEqual(
        runtime.getShakeZoneState({ x: 80, y: 50 }, { mode: "radius", safeRadius: 20, gapInner: 10 }, 100, 100),
        { centerX: 50, centerY: 50, inner: 0, outer: 20, err: 10, dangerRatio: 10 / 22 },
        "手抖挑战必须按弹珠与安全圆的真实距离判定"
    );
    assert.equal(
        runtime.getShakeZoneState({ x: 55, y: 50 }, { mode: "gap", safeRadius: 30, gapInner: 10 }, 100, 100).err,
        5,
        "夹缝模式太靠近中心也必须算出界"
    );
    assert.deepEqual(
        runtime.getAngleState(24, { targetOffset: 10, tolerance: 4, rampDegrees: 20 }),
        { offset: 24, err: 10, dangerRatio: 0.5 },
        "保持角度必须使用目标偏移、允许误差和拉满角度"
    );
    assert.equal(runtime.interpolateStrength(20, 80, 0.5), 50);
    assert.equal(runtime.rollOpponentDie("easy", () => 0), 1);
    assert.equal(runtime.rollOpponentDie("hard", () => 0), 2);

    const mainSource = fs.readFileSync(path.join(liteRoot, "js/main.js"), "utf8");
    ["safeAngle", "rampAngle", "baseStrength", "shockStrength", "lightStrength", "fullAfter"].forEach((oldKey) => {
        assert.ok(!mainSource.includes(`cfg.${oldKey}`), `运行时不得继续读取已删除的旧参数 ${oldKey}`);
    });
    ["strengthMin", "strengthMax", "targetOffset", "triggerMs", "shakeSensitivity", "opponentDifficulty", "manualRoll", "spinMs", "restMs", "autoSpin", "pressureAfterPunish"].forEach((key) => {
        assert.ok(mainSource.includes(`.${key}`), `运行时必须实际使用原版参数 ${key}`);
    });
}

async function run() {
    testProtocolEncoding();
    testWaveformAdaptation();
    await testSerializedOutputAndDurationFloor();
    await testSlowBluetoothCannotExtendFinitePulse();
    await testBleProtocolDiscovery();
    testIndependentRuleCopy();
    testGameConfigurationMatchesOriginal();
    testRequiredFiles();
    testDeploymentPathAndDirectControlConfirmation();
    testGlobalOutputControlsMatchOriginal();
    testGameSettingsExperienceMatchesOriginal();
    testRuntimeRuleParity();
    process.stdout.write("Lite 单元测试通过\n");
}

run().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
});
