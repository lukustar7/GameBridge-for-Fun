/* 使用 Node 内置测试器验证浏览器实际加载的纯游戏规则，不引入第三方测试依赖。 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const logic = require("../static/game-logic.js");

const DEFAULTS = {
    shake: {
        strengthMin: 20,
        mode: "radius"
    },
    dice: {
        strength: 20,
        singleSeconds: 2,
        gapSeconds: 0.5,
        manualRoll: true,
        opponentDifficulty: "normal"
    }
};

const DEFAULT_GLOBAL_OUTPUT = {
    outputMode: "a",
    bStrengthMode: "percent",
    bStrengthPercent: 50
};

function sequenceRandom(values) {
    let index = 0;
    return () => values[index++] ?? 0.5;
}

test("本地设置只恢复已知且类型正确的字段", () => {
    const restored = logic.restoreSettings(DEFAULTS, {
        shake: {
            strengthMin: 35,
            mode: "gap",
            unknown: "ignored"
        },
        dice: {
            manualRoll: false,
            opponentDifficulty: "impossible",
            gapSeconds: "0.1"
        },
        injectedGame: { enabled: true }
    });

    assert.equal(restored.shake.strengthMin, 35);
    assert.equal(restored.shake.mode, "gap");
    assert.equal(restored.dice.manualRoll, false);
    assert.equal(restored.dice.opponentDifficulty, "normal");
    assert.equal(restored.dice.gapSeconds, 0.5);
    assert.equal(Object.hasOwn(restored.shake, "unknown"), false);
    assert.equal(Object.hasOwn(restored, "injectedGame"), false);
});

test("已确认且合法的全局输出设置可以恢复", () => {
    const restored = logic.resolveStoredGlobalOutputSettings(DEFAULT_GLOBAL_OUTPUT, {
        outputMode: "ab",
        bStrengthMode: "same",
        bStrengthPercent: 80,
        confirmed: true
    });

    assert.deepEqual(restored, {
        settings: {
            outputMode: "ab",
            bStrengthMode: "same",
            bStrengthPercent: 80
        },
        requiresConfirmation: false
    });
});

test("损坏或未确认的全局输出设置必须暂停正式输出", () => {
    const unconfirmed = logic.resolveStoredGlobalOutputSettings(DEFAULT_GLOBAL_OUTPUT, {
        outputMode: "b",
        bStrengthMode: "percent",
        bStrengthPercent: 40,
        confirmed: false
    });
    const damaged = logic.resolveStoredGlobalOutputSettings(DEFAULT_GLOBAL_OUTPUT, {
        outputMode: "unknown",
        bStrengthMode: "same",
        bStrengthPercent: Number.POSITIVE_INFINITY,
        confirmed: true
    });

    assert.equal(unconfirmed.requiresConfirmation, true);
    assert.equal(unconfirmed.settings.outputMode, "b");
    assert.equal(damaged.requiresConfirmation, true);
    assert.deepEqual(damaged.settings, DEFAULT_GLOBAL_OUTPUT);
});

test("所选通道的有效游戏强度上限会考虑 B 通道比例", () => {
    assert.equal(logic.getEffectiveBaseStrengthLimit("a", 35, 20, "percent", 50), 35);
    assert.equal(logic.getEffectiveBaseStrengthLimit("b", 35, 28, "same", 50), 28);
    assert.equal(logic.getEffectiveBaseStrengthLimit("b", 35, 20, "percent", 50), 40);
    assert.equal(logic.getEffectiveBaseStrengthLimit("ab", 35, 20, "percent", 50), 35);
    assert.equal(logic.getEffectiveBaseStrengthLimit("ab", 35, 0, "same", 50), 0);
    assert.equal(logic.getEffectiveBaseStrengthLimit("unknown", 35, 20, "same", 50), 0);
});

test("所有保留玩法的强度设置都会被首页安全限额截断且不修改原对象", () => {
    const source = {
        shake: { strengthMin: 36, strengthMax: 90, safeRadius: 20 },
        dice: { strength: 80, singleSeconds: 2 },
        slot: { strengthMin: 45, strengthMax: 100, shockSeconds: 3 },
        lightning: { startStrength: 40, maxStrength: 90, jamStrength: 70 }
    };

    const limited = logic.clampGameStrengthSettings(source, 35);

    assert.deepEqual(limited, {
        shake: { strengthMin: 35, strengthMax: 35, safeRadius: 20 },
        dice: { strength: 35, singleSeconds: 2 },
        slot: { strengthMin: 35, strengthMax: 35, shockSeconds: 3 },
        lightning: { startStrength: 35, maxStrength: 35, jamStrength: 35 }
    });
    assert.equal(source.shake.strengthMin, 36);
    assert.equal(source.lightning.maxStrength, 90);
});

test("旧版四个游戏通道一致时自动迁移为一份全局设置", () => {
    const legacyOutput = {
        outputMode: "ab",
        bStrengthMode: "percent",
        bStrengthPercent: 60
    };
    const migrated = logic.migrateLegacyOutputSettings(
        DEFAULT_GLOBAL_OUTPUT,
        {
            shake: { ...legacyOutput, strengthMin: 20 },
            angle: { ...legacyOutput, strengthMin: 15 },
            dice: { ...legacyOutput, strength: 20 },
            slot: { ...legacyOutput, strengthMax: 85 }
        },
        ["shake", "angle", "dice", "slot"]
    );

    assert.deepEqual(migrated, {
        settings: legacyOutput,
        requiresConfirmation: false
    });
});

test("旧版游戏通道互相冲突时回到安全默认并要求确认", () => {
    const migrated = logic.migrateLegacyOutputSettings(
        DEFAULT_GLOBAL_OUTPUT,
        {
            shake: { outputMode: "a", bStrengthMode: "percent", bStrengthPercent: 50 },
            angle: { outputMode: "a", bStrengthMode: "percent", bStrengthPercent: 50 },
            dice: { outputMode: "b", bStrengthMode: "percent", bStrengthPercent: 50 },
            slot: { outputMode: "a", bStrengthMode: "percent", bStrengthPercent: 50 }
        },
        ["shake", "angle", "dice", "slot"]
    );

    assert.deepEqual(migrated.settings, DEFAULT_GLOBAL_OUTPUT);
    assert.equal(migrated.requiresConfirmation, true);
});

test("没有旧版通道字段的新用户直接采用安全默认", () => {
    const migrated = logic.migrateLegacyOutputSettings(
        DEFAULT_GLOBAL_OUTPUT,
        { shake: { strengthMin: 20 }, dice: { strength: 20 } },
        ["shake", "angle", "dice", "slot"]
    );

    assert.deepEqual(migrated.settings, DEFAULT_GLOBAL_OUTPUT);
    assert.equal(migrated.requiresConfirmation, false);
});

test("空值、数组或损坏根配置会完整回退默认值", () => {
    for (const saved of [null, [], "broken", 42]) {
        const restored = logic.restoreSettings(DEFAULTS, saved);
        assert.deepEqual(restored, DEFAULTS);
        assert.notEqual(restored, DEFAULTS);
        assert.notEqual(restored.shake, DEFAULTS.shake);
    }
});

test("设置恢复不会反向修改默认配置或输入对象", () => {
    const saved = { shake: { strengthMin: 45 } };
    const restored = logic.restoreSettings(DEFAULTS, saved);
    restored.shake.strengthMin = 99;

    assert.equal(DEFAULTS.shake.strengthMin, 20);
    assert.equal(saved.shake.strengthMin, 45);
});

test("旧版单次惩罚时长自动提升到一秒且不修改休息间隔", () => {
    const restored = logic.applyStandaloneShockDurationFloor({
        dice: { singleSeconds: 0.5, gapSeconds: 0.2 },
        slot: { shockSeconds: 0.5, lightShockSeconds: 0.1, restMs: 300 },
        shake: { restMs: 250 }
    });

    assert.equal(restored.dice.singleSeconds, 1);
    assert.equal(restored.slot.shockSeconds, 1);
    assert.equal(restored.slot.lightShockSeconds, 1);
    assert.equal(restored.dice.gapSeconds, 0.2);
    assert.equal(restored.slot.restMs, 300);
    assert.equal(restored.shake.restMs, 250);
});

test("普通骰子输局按双方总分差计算次数", () => {
    const outcome = logic.evaluateDiceRound([1, 2, 3], [4, 5, 6], 3);

    assert.deepEqual(outcome, {
        kind: "loss",
        playerTotal: 6,
        opponentTotal: 15,
        punishmentCount: 9,
        reason: "输了 9 点"
    });
});

test("骰子平局按玩家获胜处理且不产生惩罚", () => {
    const outcome = logic.evaluateDiceRound([1, 2, 6], [2, 3, 4], 3);

    assert.equal(outcome.kind, "win");
    assert.equal(outcome.punishmentCount, 0);
    assert.equal(outcome.reason, "你赢了 | 9 : 9");
});

test("任意一方豹子都按点数乘倍率结算", () => {
    const playerTriple = logic.evaluateDiceRound([4, 4, 4], [1, 2, 3], 3);
    const opponentTriple = logic.evaluateDiceRound([1, 2, 3], [5, 5, 5], 2);
    const bothTriple = logic.evaluateDiceRound([2, 2, 2], [6, 6, 6], 4);

    assert.equal(playerTriple.punishmentCount, 12);
    assert.equal(playerTriple.reason, "你 4 点豹子");
    assert.equal(opponentTriple.punishmentCount, 10);
    assert.equal(opponentTriple.reason, "对手 5 点豹子");
    assert.equal(bothTriple.punishmentCount, 24);
    assert.equal(bothTriple.reason, "双方 6 点豹子");
});

test("非法骰子点数会明确失败而不是静默算出错误结果", () => {
    assert.throws(
        () => logic.evaluateDiceRound([0, 2, 3], [4, 5, 6], 3),
        /1 到 6/
    );
    assert.throws(() => logic.getTripleFace([1, 1]), /3 个/);
});

test("骰子惩罚次数和队列时间处理零值、上限与间隔", () => {
    assert.equal(logic.capPunishmentCount(-5, 30), 0);
    assert.equal(logic.capPunishmentCount(80, 30), 30);
    assert.equal(logic.capPunishmentCount(2.6, 30), 3);
    assert.equal(logic.estimateDiceQueueSeconds(3, { singleSeconds: 2, gapSeconds: 0.5 }), 7);
    assert.equal(logic.estimateDiceQueueSeconds(0, { singleSeconds: 2, gapSeconds: 0.5 }), 0);

    const longPlan = logic.calculateDiceExecutionPlan(36, {
        singleSeconds: 30,
        maxPunishCount: 36
    });
    assert.deepEqual(longPlan, {
        ruleCount: 36,
        maximumCount: 36,
        budgetCount: 10,
        executionCount: 10,
        singleSeconds: 30,
        outputSeconds: 300,
        truncated: true
    });
    const completePlan = logic.calculateDiceExecutionPlan(36, {
        singleSeconds: 5,
        maxPunishCount: 36
    });
    assert.equal(completePlan.executionCount, 36);
    assert.equal(completePlan.outputSeconds, 180);
});

test("传感器时间戳超过硬期限后立即视为失效", () => {
    assert.equal(logic.isTimestampFresh(1000, 1600, 2599), true);
    assert.equal(logic.isTimestampFresh(1000, 1600, 2600), false);
    assert.equal(logic.isTimestampFresh(0, 1600, 1000), false);
    assert.equal(logic.isTimestampFresh(2000, 1600, 1000), false);
});

test("雷电极速设置会被限制在允许调整的安全范围", () => {
    const normalized = logic.normalizeLightningSettings({
        startSpeed: 2,
        startStrength: 40,
        maxStrength: 20,
        fullSpeed: 59,
        continuousSeconds: 99,
        drivingRestSeconds: 0,
        overspeedRecoverySeconds: 1,
        sessionMinutes: 99,
        jamEnabled: true,
        jamStrength: 200,
        jamEntrySeconds: 1,
        jamShockSeconds: 0.2,
        jamGapMinSeconds: 4,
        jamGapMaxSeconds: 5,
        jamBatchCount: 99,
        jamBatchRestSeconds: 2
    }, {});

    assert.deepEqual(normalized, {
        startSpeed: 5,
        startStrength: 40,
        maxStrength: 40,
        fullSpeed: 55,
        continuousSeconds: 30,
        drivingRestSeconds: 3,
        overspeedRecoverySeconds: 1,
        sessionMinutes: 30,
        jamEnabled: true,
        jamStrength: 40,
        jamEntrySeconds: 20,
        jamShockSeconds: 1,
        jamGapMinSeconds: 10,
        jamGapMaxSeconds: 15,
        jamBatchCount: 10,
        jamBatchRestSeconds: 30
    });
});

test("雷电极速强度先线性增加并在 55 后主动回落", () => {
    const cfg = {
        startSpeed: 10,
        startStrength: 20,
        maxStrength: 80,
        fullSpeed: 50
    };

    assert.equal(logic.calculateLightningStrength(9.9, cfg), 0);
    assert.equal(logic.calculateLightningStrength(10, cfg), 20);
    assert.equal(logic.calculateLightningStrength(30, cfg), 50);
    assert.equal(logic.calculateLightningStrength(50, cfg), 80);
    assert.equal(logic.calculateLightningStrength(55, cfg), 80);
    assert.equal(logic.calculateLightningStrength(57.5, cfg), 50);
    assert.equal(logic.calculateLightningStrength(60, cfg), 0);
});

test("雷电极速允许从任意合规速度进入但必须稳定两秒", () => {
    const cfg = { startSpeed: 10, sessionMinutes: 10 };
    let state = logic.createLightningState(1000);

    let result = logic.advanceLightningState(state, cfg, {
        valid: true,
        speedKmh: 32,
        timestamp: 1000
    }, 1000);
    assert.equal(result.state.mode, "waiting_speed");

    result = logic.advanceLightningState(result.state, cfg, {
        valid: true,
        speedKmh: 32,
        timestamp: 2999
    }, 2999);
    assert.equal(result.state.mode, "waiting_speed");

    result = logic.advanceLightningState(result.state, cfg, {
        valid: true,
        speedKmh: 32,
        timestamp: 3000
    }, 3000);
    assert.equal(result.state.mode, "driving");
    assert.ok(result.strength > 0);
});

test("雷电极速达到 60 立即停止并按用户设置等待恢复", () => {
    const cfg = { startSpeed: 10, overspeedRecoverySeconds: 5, sessionMinutes: 10 };
    let state = {
        ...logic.createLightningState(1000),
        mode: "driving",
        modeSince: 3000
    };
    let result = logic.advanceLightningState(state, cfg, {
        valid: true,
        speedKmh: 60,
        timestamp: 4000
    }, 4000);
    assert.equal(result.state.mode, "overspeed");
    assert.equal(result.shouldStop, true);

    result = logic.advanceLightningState(result.state, cfg, {
        valid: true,
        speedKmh: 40,
        timestamp: 5000
    }, 5000);
    assert.equal(result.state.mode, "overspeed");

    result = logic.advanceLightningState(result.state, cfg, {
        valid: true,
        speedKmh: 40,
        timestamp: 9999
    }, 9999);
    assert.equal(result.state.mode, "overspeed");

    result = logic.advanceLightningState(result.state, cfg, {
        valid: true,
        speedKmh: 40,
        timestamp: 10000
    }, 10000);
    assert.equal(result.state.mode, "driving");
});

test("雷电极速允许用户选择零秒超速恢复", () => {
    const cfg = { startSpeed: 10, overspeedRecoverySeconds: 0, sessionMinutes: 10 };
    let state = {
        ...logic.createLightningState(1000),
        mode: "driving",
        overspeedLatched: true
    };
    const result = logic.advanceLightningState(state, cfg, {
        valid: true,
        speedKmh: 40,
        timestamp: 2000
    }, 2000);
    assert.equal(result.state.mode, "driving");
    assert.equal(result.state.overspeedLatched, false);
});

test("雷电极速超速恢复期间丢失定位会重新计算完整等待时间", () => {
    const cfg = { startSpeed: 10, overspeedRecoverySeconds: 5, sessionMinutes: 10 };
    let result = logic.advanceLightningState({
        ...logic.createLightningState(1000),
        mode: "driving"
    }, cfg, { valid: true, speedKmh: 62, timestamp: 2000 }, 2000);
    assert.equal(result.state.mode, "overspeed");

    result = logic.advanceLightningState(
        result.state,
        cfg,
        { valid: true, speedKmh: 40, timestamp: 3000 },
        3000
    );
    assert.equal(result.state.mode, "overspeed");

    result = logic.advanceLightningState(
        result.state,
        cfg,
        { valid: false, speedKmh: null, timestamp: 3500 },
        3500
    );
    assert.equal(result.state.mode, "gps_blocked");
    assert.equal(result.state.overspeedLatched, true);

    result = logic.advanceLightningState(
        result.state,
        cfg,
        { valid: true, speedKmh: 40, timestamp: 4000 },
        4000
    );
    assert.equal(result.state.mode, "overspeed");
    result = logic.advanceLightningState(
        result.state,
        cfg,
        { valid: true, speedKmh: 40, timestamp: 8999 },
        8999
    );
    assert.equal(result.state.mode, "overspeed");
    result = logic.advanceLightningState(
        result.state,
        cfg,
        { valid: true, speedKmh: 40, timestamp: 9000 },
        9000
    );
    assert.equal(result.state.mode, "driving");
});

test("雷电极速低速只使用一个计时器并在恢复后重置", () => {
    const cfg = { startSpeed: 10, jamEnabled: true, jamEntrySeconds: 20, sessionMinutes: 10 };
    let result = logic.advanceLightningState({
        ...logic.createLightningState(1000),
        mode: "driving",
        modeSince: 3000
    }, cfg, {
        valid: true,
        speedKmh: 8,
        timestamp: 4000
    }, 4000);
    assert.equal(result.state.mode, "low_pending");
    assert.equal(result.shouldStop, true);

    result = logic.advanceLightningState(result.state, cfg, {
        valid: true,
        speedKmh: 8,
        timestamp: 9000
    }, 9000);
    assert.equal(result.state.mode, "low_paused");

    result = logic.advanceLightningState(result.state, cfg, {
        valid: true,
        speedKmh: 8,
        timestamp: 24000
    }, 24000);
    assert.equal(result.state.mode, "jam");

    result = logic.advanceLightningState(result.state, cfg, {
        valid: true,
        speedKmh: 12,
        timestamp: 26000
    }, 26000);
    assert.equal(result.state.mode, "low_pending");
    assert.equal(result.shouldStop, true);
    result = logic.advanceLightningState(result.state, cfg, {
        valid: true,
        speedKmh: 12,
        timestamp: 28000
    }, 28000);
    assert.equal(result.state.mode, "driving");
    assert.equal(result.state.lowSince, null);
});

test("雷电极速刚低于用户启动线就停止而不是继续使用迟滞区", () => {
    const cfg = { startSpeed: 10, sessionMinutes: 10 };
    const state = {
        ...logic.createLightningState(1000),
        mode: "driving",
        modeSince: 1000,
        startCandidateSince: null,
        lowSince: null
    };

    const result = logic.advanceLightningState(state, cfg, {
        valid: true,
        speedKmh: 9.9,
        timestamp: 2000
    }, 2000);

    assert.equal(result.state.mode, "low_pending");
    assert.equal(result.shouldStop, true);
    assert.equal(result.strength, 0);
});

test("雷电极速定位超过三秒未更新时停止且不会误入堵车", () => {
    const cfg = { startSpeed: 10, jamEnabled: true, sessionMinutes: 10 };
    const result = logic.advanceLightningState({
        ...logic.createLightningState(1000),
        mode: "driving",
        modeSince: 3000
    }, cfg, {
        valid: true,
        speedKmh: 20,
        timestamp: 4000
    }, 7000);

    assert.equal(result.state.mode, "gps_blocked");
    assert.equal(result.shouldStop, true);
    assert.equal(result.state.lowSince, null);
});

test("设置数值只给仍在使用的字段添加对应单位", () => {
    assert.equal(logic.formatSettingLabel("shake-strength-min", 15), "15");
    assert.equal(logic.formatSettingLabel("slot-shock-seconds", 2), "2.0s");
    assert.equal(logic.formatSettingLabel("slot-miss-gain", 24), "24%");
});

test("安全就绪状态要求所选通道都拿到有效限幅", () => {
    assert.equal(logic.hasSafeOutputLimits("a", 80, null), true);
    assert.equal(logic.hasSafeOutputLimits("b", 80, 60), true);
    assert.equal(logic.hasSafeOutputLimits("b", 80, 0), false);
    assert.equal(logic.hasSafeOutputLimits("ab", 80, null), false);
    assert.equal(logic.hasSafeOutputLimits("ab", 80, 60), true);
    assert.equal(logic.hasSafeOutputLimits("unknown", 80, 60), false);
});

test("三档角子机中奖率保持固定规则", () => {
    assert.deepEqual(logic.getSlotOdds("loose"), { small: 0.42, jackpot: 0.14 });
    assert.deepEqual(logic.getSlotOdds("normal"), { small: 0.32, jackpot: 0.09 });
    assert.deepEqual(logic.getSlotOdds("brutal"), { small: 0.22, jackpot: 0.06 });
    assert.deepEqual(logic.getSlotOdds("broken"), { small: 0.32, jackpot: 0.09 });
});

test("角子机只把三个 7️⃣ 图标识别为特殊事件", () => {
    assert.equal(logic.classifySlotResult(["A", "B", "C"]), "miss");
    assert.equal(logic.classifySlotResult(["A", "A", "B"]), "small");
    assert.equal(logic.classifySlotResult(["A", "A", "A"]), "jackpot");
    assert.equal(logic.classifySlotResult(["🎰", "🎰", "🎰"]), "jackpot");
    assert.equal(logic.classifySlotResult(["7️⃣", "7️⃣", "7️⃣"]), "seven");
    assert.throws(() => logic.classifySlotResult(["A", "B"]), /3 个/);
});

test("角子机随机数边界能稳定生成四种可分类结果", () => {
    const symbols = ["A", "B", "C", "7️⃣"];
    const seven = logic.buildSlotResult(
        { winRate: "normal" },
        symbols,
        sequenceRandom([0.01, 0.01])
    );
    const jackpot = logic.buildSlotResult(
        { winRate: "normal" },
        symbols,
        sequenceRandom([0.01, 0.8, 0])
    );
    const small = logic.buildSlotResult(
        { winRate: "normal" },
        symbols,
        sequenceRandom([0.2, 0, 0, 0, 0])
    );
    const miss = logic.buildSlotResult(
        { winRate: "normal" },
        symbols,
        sequenceRandom([0.9, 0, 0, 0, 0, 0])
    );

    assert.equal(logic.classifySlotResult(seven), "seven");
    assert.equal(logic.classifySlotResult(jackpot), "jackpot");
    assert.equal(logic.classifySlotResult(small), "small");
    assert.equal(logic.classifySlotResult(miss), "miss");
});

test("连续空奖会叠加连败增量并在满格时触发惩罚", () => {
    const cfg = { missGain: 24, streakBonus: 6 };
    const first = logic.advanceSlotState({ pressure: 0, missStreak: 0 }, cfg, "miss");
    const second = logic.advanceSlotState(first, cfg, "miss");
    const full = logic.advanceSlotState({ pressure: 90, missStreak: 3 }, cfg, "miss");

    assert.equal(first.pressure, 24);
    assert.equal(first.missStreak, 1);
    assert.equal(second.pressure, 54);
    assert.equal(second.missStreak, 2);
    assert.equal(full.pressure, 100);
    assert.equal(full.triggerPunishment, true);
    assert.equal(full.punishmentReason, "压力满格");
});

test("小奖和大奖按规则降低压力并正确处理连败次数", () => {
    const cfg = { smallWinDrop: 14, jackpotDrop: 70 };
    const small = logic.advanceSlotState({ pressure: 60, missStreak: 3 }, cfg, "small");
    const jackpot = logic.advanceSlotState({ pressure: 60, missStreak: 3 }, cfg, "jackpot");

    assert.equal(small.pressure, 46);
    assert.equal(small.missStreak, 2);
    assert.equal(jackpot.pressure, 0);
    assert.equal(jackpot.missStreak, 0);
});

test("7️⃣ × 3 的清零、延后满槽和立即惩罚规则互不重复", () => {
    const reset = logic.advanceSlotState({ pressure: 80, missStreak: 4 }, { sevenRule: "reset" }, "seven");
    const fill = logic.advanceSlotState({ pressure: 20, missStreak: 1 }, { sevenRule: "fill" }, "seven");
    const shock = logic.advanceSlotState({ pressure: 20, missStreak: 1 }, { sevenRule: "shock" }, "seven");
    const damaged = logic.advanceSlotState({ pressure: 20, missStreak: 1 }, { sevenRule: "broken" }, "seven");

    assert.equal(reset.pressure, 0);
    assert.equal(reset.triggerPunishment, false);
    assert.equal(fill.pressure, 100);
    assert.equal(fill.triggerPunishment, false);
    assert.match(fill.message, /本局不输出/);
    assert.equal(shock.pressure, 100);
    assert.equal(shock.triggerPunishment, true);
    assert.equal(shock.punishmentReason, "7️⃣ × 3 特殊事件");
    assert.equal(damaged.triggerPunishment, false);
});

test("7️⃣ × 3 进入满槽后由下一局输赢决定是否惩罚", () => {
    const cfg = { sevenRule: "fill", missGain: 24, streakBonus: 6, smallWinDrop: 14 };
    const armed = logic.advanceSlotState({ pressure: 35, missStreak: 2 }, cfg, "seven");
    const miss = logic.advanceSlotState(armed, cfg, "miss");
    const win = logic.advanceSlotState(armed, cfg, "small");

    assert.equal(armed.pressure, 100);
    assert.equal(armed.triggerPunishment, false);
    assert.equal(miss.pressure, 100);
    assert.equal(miss.triggerPunishment, true);
    assert.equal(win.pressure, 86);
    assert.equal(win.triggerPunishment, false);
});

test("未知角子机结果会明确失败", () => {
    assert.throws(
        () => logic.advanceSlotState({ pressure: 0, missStreak: 0 }, {}, "unknown"),
        /未知角子机/
    );
});
