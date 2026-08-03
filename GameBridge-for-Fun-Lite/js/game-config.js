(function exposeLiteGameConfig(root, factory) {
    "use strict";

    const api = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.LiteGameConfig = api;
    }
}(typeof globalThis !== "undefined" ? globalThis : this, function createLiteGameConfig() {
    "use strict";

    const DEFAULT_OUTPUT_SETTINGS = Object.freeze({
        outputMode: "a",
        bStrengthMode: "percent",
        bStrengthPercent: 50
    });

    const DEFAULT_DEVICE_LIMITS = Object.freeze({ limitA: 30, limitB: 30 });

    const DEFAULT_SETTINGS = Object.freeze({
        shake: Object.freeze({
            strengthMin: 20,
            strengthMax: 60,
            mode: "radius",
            safeRadius: 26,
            gapInner: 12,
            sensitivity: 55,
            forgiveMs: 600
        }),
        dice: Object.freeze({
            strength: 20,
            singleSeconds: 2.0,
            gapSeconds: 0.5,
            leopardMultiplier: 3,
            maxPunishCount: 30,
            shakeSensitivity: 15,
            opponentDifficulty: "normal",
            manualRoll: true
        }),
        slot: Object.freeze({
            strengthMin: 20,
            strengthMax: 85,
            shockSeconds: 2.0,
            lightPunishEnabled: false,
            lightShockSeconds: 1.0,
            restMs: 800,
            spinMs: 700,
            autoSpin: false,
            autoIntervalMs: 650,
            missGain: 24,
            streakBonus: 6,
            smallWinDrop: 14,
            jackpotDrop: 70,
            winRate: "normal",
            sevenRule: "fill",
            pressureAfterPunish: "clear"
        }),
        lightning: Object.freeze({
            startSpeed: 10,
            startStrength: 20,
            maxStrength: 80,
            fullSpeed: 50,
            continuousSeconds: 8,
            drivingRestSeconds: 3,
            overspeedRecoverySeconds: 10,
            sessionMinutes: 10,
            jamEnabled: false,
            jamStrength: 30,
            jamEntrySeconds: 40,
            jamShockSeconds: 1.5,
            jamGapMinSeconds: 12,
            jamGapMaxSeconds: 25,
            jamBatchCount: 5,
            jamBatchRestSeconds: 60
        })
    });

    const GAME_META = Object.freeze({
        shake: Object.freeze({
            title: "手抖挑战",
            description: "让弹珠留在安全区内；持续出界后按距离逐步增加强度。"
        }),
        dice: Object.freeze({
            title: "摇骰子对决",
            description: "双方各摇三颗骰子；输几点输出几下，豹子按点数乘倍率结算。"
        }),
        slot: Object.freeze({
            title: "极速角子机",
            description: "三个图标同时开奖；未中奖会推高压力，满槽后按规则结算。"
        }),
        lightning: Object.freeze({
            title: "雷电极速",
            description: "达到启动速度后按速度改变强度；低速、超速、定位异常和到时都会停止。"
        })
    });

    const SETTING_GROUPS = Object.freeze({
        shake: Object.freeze([
            Object.freeze({ title: "基础玩法", fields: Object.freeze([
                Object.freeze({ key: "mode", label: "游戏模式", type: "select", options: Object.freeze([["radius", "安全半径模式"], ["gap", "夹缝生存模式"]]), help: "安全半径要求弹珠留在圆内；夹缝模式要求弹珠留在内外圈之间。" }),
                Object.freeze({ key: "strengthMin", label: "开始电的强度", type: "range", min: 0, max: 200, step: 1, unit: "", help: "持续出界并刚开始输出时使用的强度。" }),
                Object.freeze({ key: "strengthMax", label: "最强电到多少", type: "range", min: 0, max: 200, step: 1, unit: "", help: "弹珠离安全区越远，强度越接近这里。" }),
                Object.freeze({ key: "safeRadius", label: "安全区半径", type: "range", min: 12, max: 45, step: 1, unit: "%", help: "普通模式下越大越容易；夹缝模式下代表外圈边界。" }),
                Object.freeze({ key: "gapInner", label: "夹缝内圈半径", type: "range", min: 6, max: 28, step: 1, unit: "%", visibleWhen: Object.freeze({ key: "mode", equals: "gap" }), help: "仅夹缝模式使用，弹珠太靠近中心同样会出界。" })
            ]) }),
            Object.freeze({ title: "高级节奏", fields: Object.freeze([
                Object.freeze({ key: "sensitivity", label: "倾斜灵敏度", type: "range", min: 20, max: 100, step: 1, unit: "", help: "越高时，相同倾斜会让弹珠移动得更快。" }),
                Object.freeze({ key: "forgiveMs", label: "出界多久才电", type: "range", min: 0, max: 2000, step: 100, unit: " ms", help: "离开安全区后先等待一段时间，避免瞬间晃动误触发。" })
            ]) })
        ]),
        dice: Object.freeze([
            Object.freeze({ title: "基础玩法", fields: Object.freeze([
                Object.freeze({ key: "strength", label: "每下强度", type: "range", min: 0, max: 200, step: 1, unit: "", help: "每一次骰子结算输出使用的请求强度。" }),
                Object.freeze({ key: "singleSeconds", label: "每下多久", type: "range", min: 1, max: 30, step: 0.5, unit: " 秒", help: "每一下持续 1–30 秒，单局累计真实输出最多 300 秒。" })
            ]) }),
            Object.freeze({ title: "高级规则", fields: Object.freeze([
                Object.freeze({ key: "gapSeconds", label: "每下间隔", type: "range", min: 0.2, max: 3, step: 0.1, unit: " 秒", help: "每一下结束后休息多久，再执行下一下。" }),
                Object.freeze({ key: "leopardMultiplier", label: "豹子倍率", type: "range", min: 1, max: 6, step: 1, unit: " 倍", help: "任意一方摇出三个相同点数时，用点数乘这个倍率。" }),
                Object.freeze({ key: "maxPunishCount", label: "单局最多电几下", type: "range", min: 1, max: 36, step: 1, unit: " 下", help: "当前规则理论最高为六点豹子乘六倍，共 36 下。" }),
                Object.freeze({ key: "shakeSensitivity", label: "摇晃灵敏度", type: "range", min: 8, max: 35, step: 1, unit: "", help: "越低越容易识别为摇骰子，越高则需要更明显的晃动。" }),
                Object.freeze({ key: "opponentDifficulty", label: "对手难度", type: "select", options: Object.freeze([["easy", "较弱"], ["normal", "标准"], ["hard", "较强"]]), help: "对手越强，越容易摇出较高点数。" }),
                Object.freeze({ key: "manualRoll", label: "允许手动摇号", type: "toggle", help: "开启后可以点击按钮开局；关闭后只能靠手机摇晃。" })
            ]) })
        ]),
        slot: Object.freeze([
            Object.freeze({ title: "基础输出", fields: Object.freeze([
                Object.freeze({ key: "strengthMax", label: "满槽惩罚强度", type: "range", min: 0, max: 200, step: 1, unit: "", help: "压力满格或立即惩罚时使用，仍受网页通道上限约束。" }),
                Object.freeze({ key: "shockSeconds", label: "满槽惩罚多久", type: "range", min: 1, max: 30, step: 0.5, unit: " 秒", help: "满槽惩罚持续 1–30 秒，结束后再进入休息。" }),
                Object.freeze({ key: "pressureAfterPunish", label: "满槽惩罚后压力", type: "select", options: Object.freeze([["clear", "清空压力"], ["keep", "保留 100%"]]), help: "决定真实完成满槽惩罚后，压力条如何继续。" })
            ]) }),
            Object.freeze({ title: "轻电规则", fields: Object.freeze([
                Object.freeze({ key: "lightPunishEnabled", label: "没中奖轻电", type: "toggle", help: "开启后，三个图标全不同时会轻电一下。" }),
                Object.freeze({ key: "strengthMin", label: "没中奖轻电强度", type: "range", min: 0, max: 200, step: 1, unit: "", help: "只在开启没中奖轻电后使用，并受网页通道上限约束。" }),
                Object.freeze({ key: "lightShockSeconds", label: "轻电多久", type: "range", min: 1, max: 2, step: 0.1, unit: " 秒", help: "每次没中奖轻电持续 1–2 秒，不与上一轮叠加。" })
            ]) }),
            Object.freeze({ title: "游戏节奏", fields: Object.freeze([
                Object.freeze({ key: "restMs", label: "电完休息", type: "range", min: 300, max: 3000, step: 100, unit: " ms", help: "输出结束后至少等待多久，自动连转同样遵守。" }),
                Object.freeze({ key: "spinMs", label: "转多久开奖", type: "range", min: 450, max: 1400, step: 50, unit: " ms", help: "从开始转动到显示最终结果的时间。" }),
                Object.freeze({ key: "autoSpin", label: "自动连转", type: "toggle", help: "开启后会在每轮完成并满足休息规则后自动开转。" }),
                Object.freeze({ key: "autoIntervalMs", label: "自动连转间隔", type: "range", min: 300, max: 1800, step: 50, unit: " ms", help: "自动连转两轮之间的等待时间。" })
            ]) }),
            Object.freeze({ title: "压力规则", fields: Object.freeze([
                Object.freeze({ key: "missGain", label: "没中奖涨多少压力", type: "range", min: 8, max: 45, step: 1, unit: "%", help: "三个图标全不同时增加的基础压力。" }),
                Object.freeze({ key: "streakBonus", label: "连续没中奖加码", type: "range", min: 0, max: 15, step: 1, unit: "%", help: "连续全不同时，每多一轮额外增加的压力。" }),
                Object.freeze({ key: "smallWinDrop", label: "小奖降多少压力", type: "range", min: 0, max: 35, step: 1, unit: "%", help: "两个相同图标时减少的压力。" }),
                Object.freeze({ key: "jackpotDrop", label: "大奖降多少压力", type: "range", min: 20, max: 100, step: 1, unit: "%", help: "三个相同图标时减少的压力。" })
            ]) }),
            Object.freeze({ title: "特殊规则", fields: Object.freeze([
                Object.freeze({ key: "winRate", label: "中奖率档位", type: "select", options: Object.freeze([["loose", "宽松"], ["normal", "标准"], ["brutal", "残酷"]]), help: "控制小奖和大奖的大致概率。" }),
                Object.freeze({ key: "sevenRule", label: "三个图标全是 7️⃣ 时", type: "select", options: Object.freeze([["reset", "当作大奖：压力清零"], ["fill", "进入满槽：本局不输出"], ["shock", "立即执行满槽惩罚"]]), help: "仅当三个图标全部是 7️⃣ 时触发这项特殊规则。" })
            ]) })
        ]),
        lightning: Object.freeze([
            Object.freeze({ title: "基础玩法", fields: Object.freeze([
                Object.freeze({ key: "startStrength", label: "起始强度", type: "range", min: 0, max: 100, step: 1, unit: "", help: "达到启动速度时使用的请求强度。" }),
                Object.freeze({ key: "maxStrength", label: "最高强度", type: "range", min: 0, max: 100, step: 1, unit: "", help: "达到满强度速度后使用，仍受网页通道上限约束。" }),
                Object.freeze({ key: "fullSpeed", label: "满强度速度", type: "range", min: 15, max: 55, step: 1, unit: " km/h", help: "从启动速度到这里线性增加强度。" })
            ]) }),
            Object.freeze({ title: "行驶与保护", fields: Object.freeze([
                Object.freeze({ key: "startSpeed", label: "启动速度", type: "range", min: 5, max: 20, step: 1, unit: " km/h", help: "达到这里并稳定 2 秒后启动，不要求从静止起步。" }),
                Object.freeze({ key: "continuousSeconds", label: "每轮连续输出", type: "range", min: 3, max: 30, step: 1, unit: " 秒", help: "每轮持续 3–30 秒，期间持续检查速度和定位。" }),
                Object.freeze({ key: "drivingRestSeconds", label: "每轮强制休息", type: "range", min: 3, max: 30, step: 1, unit: " 秒", help: "一轮结束后等待 3–30 秒，规则切换同样遵守。" }),
                Object.freeze({ key: "overspeedRecoverySeconds", label: "超速恢复等待", type: "range", min: 0, max: 10, step: 1, unit: " 秒", help: "达到 60 km/h 会停止；低于 60 后按这里等待。" }),
                Object.freeze({ key: "sessionMinutes", label: "单局时长", type: "range", min: 1, max: 30, step: 1, unit: " 分钟", help: "到时立即停止，重新开始前必须再次确认移动安全。" })
            ]) }),
            Object.freeze({ title: "堵车模式", fields: Object.freeze([
                Object.freeze({ key: "jamEnabled", label: "启用“都是你的错”", type: "toggle", help: "默认关闭；关闭时长时间低速只会暂停。" }),
                Object.freeze({ key: "jamStrength", label: "堵车输出强度", type: "range", min: 0, max: 100, step: 1, unit: "", help: "不会超过当前玩法最高强度和网页通道上限。" }),
                Object.freeze({ key: "jamEntrySeconds", label: "低速多久进入堵车", type: "range", min: 20, max: 120, step: 5, unit: " 秒", help: "持续低速达到这段时间后进入堵车规则。" }),
                Object.freeze({ key: "jamShockSeconds", label: "堵车单次输出", type: "range", min: 1, max: 20, step: 0.5, unit: " 秒", help: "每次堵车随机输出持续 1–20 秒。" }),
                Object.freeze({ key: "jamGapMinSeconds", label: "随机间隔下限", type: "range", min: 10, max: 60, step: 1, unit: " 秒", help: "每次输出后随机休息的最短时间。" }),
                Object.freeze({ key: "jamGapMaxSeconds", label: "随机间隔上限", type: "range", min: 15, max: 120, step: 1, unit: " 秒", help: "始终至少比随机间隔下限多 5 秒。" }),
                Object.freeze({ key: "jamBatchCount", label: "每轮最多次数", type: "range", min: 1, max: 10, step: 1, unit: " 次", help: "达到次数后强制进入整轮休息。" }),
                Object.freeze({ key: "jamBatchRestSeconds", label: "每轮结束休息", type: "range", min: 30, max: 180, step: 5, unit: " 秒", help: "每轮完成后强制休息 30–180 秒。" })
            ]) })
        ])
    });

    const SETTING_CATEGORIES = Object.freeze({
        shake: Object.freeze([{ label: "基础", groups: [0] }, { label: "节奏", groups: [1] }]),
        dice: Object.freeze([{ label: "基础", groups: [0] }, { label: "规则", groups: [1] }]),
        slot: Object.freeze([{ label: "基础", groups: [0, 1] }, { label: "节奏", groups: [2] }, { label: "规则", groups: [3, 4] }]),
        lightning: Object.freeze([{ label: "基础", groups: [0] }, { label: "行驶", groups: [1] }, { label: "堵车", groups: [2] }])
    });

    function cloneDefaultSettings() {
        return Object.fromEntries(
            Object.entries(DEFAULT_SETTINGS).map(([gameName, settings]) => [gameName, { ...settings }])
        );
    }

    function normalizeSettings(candidate) {
        const normalized = cloneDefaultSettings();
        const source = candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate : {};
        Object.entries(SETTING_GROUPS).forEach(([gameName, groups]) => {
            const savedGame = source[gameName];
            if (!savedGame || typeof savedGame !== "object" || Array.isArray(savedGame)) return;
            groups.flatMap((group) => group.fields).forEach((field) => {
                const value = savedGame[field.key];
                if (field.type === "range" && typeof value === "number" && Number.isFinite(value)) {
                    normalized[gameName][field.key] = Math.min(field.max, Math.max(field.min, value));
                } else if (field.type === "toggle" && typeof value === "boolean") {
                    normalized[gameName][field.key] = value;
                } else if (field.type === "select" && field.options.some(([allowed]) => allowed === value)) {
                    normalized[gameName][field.key] = value;
                }
            });
        });

        ["shake", "slot"].forEach((gameName) => {
            const cfg = normalized[gameName];
            if (cfg.strengthMin > cfg.strengthMax) {
                [cfg.strengthMin, cfg.strengthMax] = [cfg.strengthMax, cfg.strengthMin];
            }
        });
        const lightning = normalized.lightning;
        lightning.maxStrength = Math.max(lightning.startStrength, lightning.maxStrength);
        lightning.fullSpeed = Math.max(lightning.startSpeed + 10, lightning.fullSpeed);
        lightning.jamStrength = Math.min(lightning.maxStrength, lightning.jamStrength);
        lightning.jamGapMaxSeconds = Math.max(lightning.jamGapMinSeconds + 5, lightning.jamGapMaxSeconds);
        return normalized;
    }

    return Object.freeze({
        DEFAULT_DEVICE_LIMITS,
        DEFAULT_OUTPUT_SETTINGS,
        DEFAULT_SETTINGS,
        GAME_META,
        SETTING_CATEGORIES,
        SETTING_GROUPS,
        cloneDefaultSettings,
        normalizeSettings
    });
}));
