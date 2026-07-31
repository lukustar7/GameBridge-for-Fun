"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

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

async function run() {
    testProtocolEncoding();
    testWaveformAdaptation();
    await testSerializedOutputAndDurationFloor();
    await testSlowBluetoothCannotExtendFinitePulse();
    await testBleProtocolDiscovery();
    testIndependentRuleCopy();
    testRequiredFiles();
    testDeploymentPathAndDirectControlConfirmation();
    process.stdout.write("Lite 单元测试通过\n");
}

run().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
});
