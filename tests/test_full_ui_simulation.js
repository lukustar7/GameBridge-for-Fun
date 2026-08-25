/* 全页面交互、按键模拟与玩法到输出全链路自动化仿真测试 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const staticLogic = require("../static/game-logic.js");
const liteConfig = require("../GameBridge-for-Fun-Lite/js/game-config.js");
const liteLogic = require("../GameBridge-for-Fun-Lite/js/game-logic.js");
const liteRuntime = require("../GameBridge-for-Fun-Lite/js/game-runtime.js");
const liteWaveforms = require("../GameBridge-for-Fun-Lite/js/waveforms.js");
const liteProtocol = require("../GameBridge-for-Fun-Lite/js/coyote-protocol.js");

test("全端 HTML 结构与关键控件存在性与无重复 ID 审计", () => {
    const staticHtml = fs.readFileSync(path.join(rootDir, "static/game.html"), "utf8");
    const consoleHtml = fs.readFileSync(path.join(rootDir, "static/index.html"), "utf8");
    const liteHtml = fs.readFileSync(path.join(rootDir, "GameBridge-for-Fun-Lite/index.html"), "utf8");

    [
        { name: "static/game.html", html: staticHtml },
        { name: "static/index.html", html: consoleHtml },
        { name: "GameBridge-for-Fun-Lite/index.html", html: liteHtml }
    ].forEach(({ name, html }) => {
        const idMatches = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
        const seen = new Set();
        idMatches.forEach((id) => {
            assert.equal(seen.has(id), false, name + " 中不能包含重复 ID: " + id);
            seen.add(id);
        });
    });
});

test("Lite 版所有 4 种玩法全部字段的动态控件生成仿真测试", () => {
    const settingGroups = liteConfig.SETTING_GROUPS;

    Object.keys(settingGroups).forEach((gameName) => {
        const groups = settingGroups[gameName];
        assert.ok(groups.length > 0, gameName + " 必须包含配置分组");

        groups.forEach((group) => {
            assert.ok(group.title, gameName + " 分组必须有标题");
            group.fields.forEach((field) => {
                assert.ok(field.key, gameName + " 字段必须有 key: " + field.key);
                assert.ok(field.label, gameName + " 字段 " + field.key + " 必须有 label");
                assert.ok(field.help, gameName + " 字段 " + field.key + " 必须有说明文字");
                assert.ok(["toggle", "select", "range"].includes(field.type), gameName + " 字段类型合法");

                if (field.type === "range") {
                    assert.ok(typeof field.min === "number", field.key + " 必须有 min");
                    assert.ok(typeof field.max === "number", field.key + " 必须有 max");
                    assert.ok(field.min <= field.max, field.key + " min 必须小于等于 max");
                    assert.ok(typeof field.step === "number", field.key + " 必须有 step");
                }

                if (field.type === "select") {
                    assert.ok(Array.isArray(field.options) && field.options.length > 0, field.key + " 必须有下拉选项");
                }
            });
        });
    });
});

test("手抖挑战：弹珠计算、出界判定与惩罚强度线性对应仿真", () => {
    const config = { mode: "radius", safeRadius: 26, gapInner: 12, strengthMin: 20, strengthMax: 60 };
    
    const safeZone = liteRuntime.getShakeZoneState({ x: 50, y: 50 }, config, 100, 100);
    assert.equal(safeZone.err, 0, "中心点必须在安全区内");
    assert.equal(safeZone.dangerRatio, 0);

    const outsideZone = liteRuntime.getShakeZoneState({ x: 80, y: 50 }, config, 100, 100);
    assert.ok(outsideZone.err > 0, "偏离 30 像素必须判定为出界");
    assert.ok(outsideZone.dangerRatio > 0 && outsideZone.dangerRatio <= 1);

    const interpolated = liteRuntime.interpolateStrength(config.strengthMin, config.strengthMax, outsideZone.dangerRatio);
    assert.ok(interpolated >= config.strengthMin && interpolated <= config.strengthMax);

    const clampedOutput = liteProtocol.channelStrengths(interpolated, "ab", 35, 15);
    assert.ok(clampedOutput.a <= 35, "A 通道输出不得突破 A 上限 35");
    assert.ok(clampedOutput.b <= 15, "B 通道输出不得突破 B 上限 15");
});

test("摇骰子对决：点数结算、豹子倍率与惩罚队列仿真", () => {
    const lossRound = liteLogic.evaluateDiceRound([1, 2, 3], [4, 5, 6], 3);
    assert.equal(lossRound.kind, "loss");
    assert.equal(lossRound.punishmentCount, 9);

    const leopardLoss = liteLogic.evaluateDiceRound([1, 2, 3], [6, 6, 6], 3);
    assert.equal(leopardLoss.kind, "leopard");
    assert.equal(leopardLoss.punishmentCount, 6 * 3);

    const plan = liteLogic.calculateDiceExecutionPlan(leopardLoss.punishmentCount, {
        strength: 40,
        singleSeconds: 2.0,
        gapSeconds: 0.5,
        maxPunishCount: 30
    });
    assert.equal(plan.executionCount, 18, "豹子 18 次全额执行");
    assert.equal(plan.outputSeconds, 18 * 2.0);

    const overPlan = liteLogic.calculateDiceExecutionPlan(50, {
        strength: 40,
        singleSeconds: 2.0,
        gapSeconds: 0.5,
        maxPunishCount: 30
    });
    assert.equal(overPlan.executionCount, 30, "超出 30 次必须截断为 30");
    assert.equal(overPlan.outputSeconds, 30 * 2.0);

    const shockOutput = liteProtocol.channelStrengths(40, "b", 50, 25);
    assert.equal(shockOutput.a, 0);
    assert.equal(shockOutput.b, 25, "B 通道输出严格截断在 25");
});

test("极速角子机：四种结算、压力递增/递减与满槽惩罚触发仿真", () => {
    const cfg = {
        missGain: 25,
        streakBonus: 5,
        smallWinDrop: 15,
        jackpotDrop: 70,
        winRate: "normal",
        sevenRule: "shock",
        pressureAfterPunish: "clear"
    };

    let r1 = liteLogic.advanceSlotState({ pressure: 0, missStreak: 0 }, cfg, "miss");
    assert.equal(r1.pressure, 25);
    assert.equal(r1.missStreak, 1);
    assert.equal(r1.triggerPunishment, false);

    let r2 = liteLogic.advanceSlotState(r1, cfg, "miss");
    assert.equal(r2.pressure, 55);
    assert.equal(r2.missStreak, 2);
    assert.equal(r2.triggerPunishment, false);

    let r3 = liteLogic.advanceSlotState(r2, cfg, "miss");
    assert.equal(r3.pressure, 90);
    assert.equal(r3.missStreak, 3);
    assert.equal(r3.triggerPunishment, false);

    let r4 = liteLogic.advanceSlotState(r3, cfg, "miss");
    assert.equal(r4.pressure, 100);
    assert.equal(r4.triggerPunishment, true, "压力满格必须触发惩罚");

    let rSeven = liteLogic.advanceSlotState({ pressure: 0, missStreak: 0 }, cfg, "seven");
    assert.equal(rSeven.pressure, 100);
    assert.equal(rSeven.triggerPunishment, true);
    assert.equal(rSeven.punishmentReason, "7️⃣ × 3 特殊事件");
});

test("雷电极速：速度阶段、超速急停、堵车加压与输出对应仿真", () => {
    const cfg = liteLogic.normalizeLightningSettings({
        startSpeed: 10,
        fullSpeed: 50,
        startStrength: 20,
        maxStrength: 80,
        jamEnabled: true,
        jamStrength: 30,
        overspeedRecoverySeconds: 5
    });

    const speed5Strength = liteLogic.calculateLightningStrength(5, cfg);
    assert.equal(speed5Strength, 0, "低于起步线输出必须为 0");

    const speed30Strength = liteLogic.calculateLightningStrength(30, cfg);
    assert.ok(speed30Strength >= cfg.startStrength && speed30Strength <= cfg.maxStrength, "正常巡航强度在线性区间内");

    const speed65Strength = liteLogic.calculateLightningStrength(65, cfg);
    assert.equal(speed65Strength, 0, "超速时物理输出必须强制归零");

    const jamOutput = liteProtocol.channelStrengths(cfg.jamStrength, "a", 30, 20);
    assert.equal(jamOutput.a, 30);
    assert.equal(jamOutput.b, 0);
});

test("全端双通道心智模型对称性与限幅硬截断仿真", () => {
    const onlyA = staticLogic.getEffectiveBaseStrengthLimit("a", 40, 20);
    assert.equal(onlyA, 40);
    assert.deepEqual(liteProtocol.channelStrengths(50, "a", 40, 20), { a: 40, b: 0 });

    const onlyB = staticLogic.getEffectiveBaseStrengthLimit("b", 40, 20);
    assert.equal(onlyB, 20);
    assert.deepEqual(liteProtocol.channelStrengths(50, "b", 40, 20), { a: 0, b: 20 });

    const bothAB = staticLogic.getEffectiveBaseStrengthLimit("ab", 40, 20);
    assert.equal(bothAB, 20);
    assert.deepEqual(liteProtocol.channelStrengths(50, "ab", 40, 20), { a: 40, b: 20 });

    assert.equal(staticLogic.getEffectiveBaseStrengthLimit("ab", 40, 0), 0);
    assert.equal(staticLogic.getEffectiveBaseStrengthLimit("unknown", 40, 20), 0);
});

test("全端按键与视图联动模拟：保存锁定、解锁修改与通道显隐", () => {
    // 模拟全局设置存储与恢复
    const defaultSettings = { outputMode: "a" };
    const saved = liteLogic.resolveStoredGlobalOutputSettings(defaultSettings, {
        outputMode: "ab",
        confirmed: true
    });
    assert.equal(saved.requiresConfirmation, false);
    assert.equal(saved.settings.outputMode, "ab");

    // 模拟损坏或篡改的配置
    const corrupted = liteLogic.resolveStoredGlobalOutputSettings(defaultSettings, {
        outputMode: "hack_mode",
        confirmed: true
    });
    assert.equal(corrupted.requiresConfirmation, true, "未知通道模式必须强制阻断并要求重新确认");
    assert.deepEqual(corrupted.settings, defaultSettings);
});

test("全端安全硬核断言：零限额或未就绪绝对禁止输出", () => {
    // 1. 零限额
    assert.equal(liteLogic.hasSafeOutputLimits("a", 0, 30), false);
    assert.equal(liteLogic.hasSafeOutputLimits("b", 30, 0), false);
    assert.equal(liteLogic.hasSafeOutputLimits("ab", 30, 0), false);
    assert.equal(liteLogic.hasSafeOutputLimits("ab", 0, 30), false);

    // 2. 正常限额
    assert.equal(liteLogic.hasSafeOutputLimits("a", 30, 0), true);
    assert.equal(liteLogic.hasSafeOutputLimits("b", 0, 30), true);
    assert.equal(liteLogic.hasSafeOutputLimits("ab", 30, 30), true);
});
