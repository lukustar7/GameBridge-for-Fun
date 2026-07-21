/* 浏览器与 Node 测试共用的纯游戏规则。这里只计算结果，不访问页面、网络或硬件。 */

(function exposeGameLogic(root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.GameBridgeForFunLogic = api;
    }
}(typeof globalThis !== "undefined" ? globalThis : this, function createGameLogic() {
    "use strict";

    // 字符串设置只接受页面明确支持的选项，防止损坏的本地缓存把游戏带入未定义分支。
    const ALLOWED_SETTING_VALUES = {
        outputMode: new Set(["a", "b", "ab"]),
        bStrengthMode: new Set(["percent", "same"]),
        mode: new Set(["radius", "gap"]),
        opponentDifficulty: new Set(["easy", "normal", "hard"]),
        winRate: new Set(["loose", "normal", "brutal"]),
        sevenRule: new Set(["reset", "fill", "shock"]),
        pressureAfterPunish: new Set(["clear", "keep"])
    };

    function clamp(value, minimum, maximum) {
        const numericValue = Number(value);
        if (!Number.isFinite(numericValue)) return minimum;
        return Math.min(maximum, Math.max(minimum, numericValue));
    }

    function cloneSettings(defaultSettings) {
        const result = {};
        Object.entries(defaultSettings).forEach(([gameName, settings]) => {
            result[gameName] = { ...settings };
        });
        return result;
    }

    function isCompatibleSetting(key, candidate, fallback) {
        if (typeof fallback === "number") {
            return typeof candidate === "number" && Number.isFinite(candidate);
        }
        if (typeof fallback === "boolean") {
            return typeof candidate === "boolean";
        }
        if (typeof fallback === "string") {
            if (typeof candidate !== "string") return false;
            const allowed = ALLOWED_SETTING_VALUES[key];
            return !allowed || allowed.has(candidate);
        }
        return false;
    }

    function restoreSettings(defaultSettings, savedSettings) {
        const restored = cloneSettings(defaultSettings);
        if (!savedSettings || typeof savedSettings !== "object" || Array.isArray(savedSettings)) {
            return restored;
        }

        // 只逐项复制默认配置中已经存在的字段。多余字段、对象注入和类型错误全部忽略。
        Object.entries(defaultSettings).forEach(([gameName, defaults]) => {
            const savedGame = savedSettings[gameName];
            if (!savedGame || typeof savedGame !== "object" || Array.isArray(savedGame)) return;

            Object.entries(defaults).forEach(([key, fallback]) => {
                const candidate = savedGame[key];
                if (isCompatibleSetting(key, candidate, fallback)) {
                    restored[gameName][key] = candidate;
                }
            });
        });
        return restored;
    }

    function validateDice(dices, label) {
        const valid = Array.isArray(dices) && dices.length === 3 &&
            dices.every((value) => Number.isInteger(value) && value >= 1 && value <= 6);
        if (!valid) {
            throw new RangeError(`${label}必须包含 3 个 1 到 6 的整数点数`);
        }
    }

    function getTripleFace(dices) {
        validateDice(dices, "骰子");
        return dices[0] === dices[1] && dices[1] === dices[2] ? dices[0] : 0;
    }

    function evaluateDiceRound(player, opponent, leopardMultiplier) {
        validateDice(player, "玩家骰子");
        validateDice(opponent, "对手骰子");
        const multiplier = Math.max(1, Math.round(Number(leopardMultiplier) || 1));
        const playerTotal = player.reduce((sum, value) => sum + value, 0);
        const opponentTotal = opponent.reduce((sum, value) => sum + value, 0);
        const playerTriple = getTripleFace(player);
        const opponentTriple = getTripleFace(opponent);

        if (playerTriple > 0 || opponentTriple > 0) {
            const tripleFace = Math.max(playerTriple, opponentTriple);
            const owner = playerTriple > 0 && opponentTriple > 0
                ? "双方"
                : (playerTriple > 0 ? "你" : "对手");
            return {
                kind: "leopard",
                playerTotal,
                opponentTotal,
                punishmentCount: tripleFace * multiplier,
                reason: `${owner} ${tripleFace} 点豹子`
            };
        }

        if (playerTotal >= opponentTotal) {
            return {
                kind: "win",
                playerTotal,
                opponentTotal,
                punishmentCount: 0,
                reason: `你赢了 | ${playerTotal} : ${opponentTotal}`
            };
        }

        const difference = opponentTotal - playerTotal;
        return {
            kind: "loss",
            playerTotal,
            opponentTotal,
            punishmentCount: difference,
            reason: `输了 ${difference} 点`
        };
    }

    function capPunishmentCount(rawCount, maximumCount) {
        const count = Math.max(0, Math.round(Number(rawCount) || 0));
        const maximum = Math.max(0, Math.round(Number(maximumCount) || 0));
        return Math.min(count, maximum);
    }

    function estimateDiceQueueSeconds(count, cfg) {
        const safeCount = Math.max(0, Math.round(Number(count) || 0));
        if (safeCount <= 0) return 0;
        const singleSeconds = Math.max(0, Number(cfg?.singleSeconds) || 0);
        const gapSeconds = Math.max(0, Number(cfg?.gapSeconds) || 0);
        return safeCount * singleSeconds + Math.max(0, safeCount - 1) * gapSeconds;
    }

    function isTimestampFresh(lastTimestamp, maximumAgeMs, now = Date.now()) {
        const timestamp = Number(lastTimestamp);
        const ageLimit = Number(maximumAgeMs);
        const currentTime = Number(now);
        if (![timestamp, ageLimit, currentTime].every(Number.isFinite)) return false;
        if (timestamp <= 0 || ageLimit <= 0 || currentTime < timestamp) return false;
        return currentTime - timestamp < ageLimit;
    }

    function formatSettingLabel(id, value) {
        // 由调用方传入字段 ID 和数值，统一生成带单位的设置标签。
        const rawValue = Number(value);
        const safeValue = Number.isFinite(rawValue) ? rawValue : 0;

        if (id.endsWith("safe-radius") || id.endsWith("gap-inner") ||
            id.endsWith("miss-gain") || id.endsWith("streak-bonus") ||
            id.endsWith("small-win-drop") || id.endsWith("jackpot-drop") ||
            id.endsWith("b-strength-percent")) {
            return `${safeValue}%`;
        }
        if (id.endsWith("forgive-ms") || id.endsWith("trigger-ms") || id.endsWith("rest-ms") ||
            id.endsWith("spin-ms") || id.endsWith("auto-interval-ms")) {
            return `${safeValue}ms`;
        }
        if (id.endsWith("shock-seconds") || id.endsWith("single-seconds") || id.endsWith("gap-seconds")) {
            return `${safeValue.toFixed(1)}s`;
        }
        if (["angle-target-offset", "angle-tolerance", "angle-ramp-degrees"].includes(id)) {
            return `${safeValue}°`;
        }
        return String(safeValue);
    }

    function hasSafeOutputLimits(mode, limitA, limitB) {
        // 顶部安全状态与正式输出共用同一判定：所选通道必须拿到大于 0 的真实硬件限幅。
        const aReady = Number.isFinite(Number(limitA)) && Number(limitA) > 0;
        const bReady = Number.isFinite(Number(limitB)) && Number(limitB) > 0;
        if (mode === "a") return aReady;
        if (mode === "b") return bReady;
        if (mode === "ab") return aReady && bReady;
        return false;
    }

    function getSlotOdds(winRate) {
        if (winRate === "loose") return { small: 0.42, jackpot: 0.14 };
        if (winRate === "brutal") return { small: 0.22, jackpot: 0.06 };
        return { small: 0.32, jackpot: 0.09 };
    }

    function readRandom(random) {
        const value = Number(random());
        if (!Number.isFinite(value)) return 0.5;
        // Math.random 正常不会返回 1；这里仍防住测试替身或未来调用方给出越界值。
        return clamp(value, 0, 1 - Number.EPSILON);
    }

    function pickSlotSymbol(symbols, excluded, random) {
        const pool = symbols.filter((symbol) => !excluded.includes(symbol));
        if (pool.length === 0) throw new RangeError("可选角子机图案不能为空");
        return pool[Math.floor(readRandom(random) * pool.length)];
    }

    function shuffleSlotReels(reels, random) {
        const result = [...reels];
        for (let index = result.length - 1; index > 0; index--) {
            const target = Math.floor(readRandom(random) * (index + 1));
            [result[index], result[target]] = [result[target], result[index]];
        }
        return result;
    }

    function buildSlotResult(cfg, symbols, random = Math.random) {
        if (!Array.isArray(symbols) || new Set(symbols).size < 3) {
            throw new RangeError("角子机至少需要 3 个不同图案");
        }
        const odds = getSlotOdds(cfg?.winRate);
        const roll = readRandom(random);

        if (roll < odds.jackpot) {
            const symbol = readRandom(random) < 0.14
                ? "7️⃣"
                : pickSlotSymbol(symbols, ["7️⃣"], random);
            return [symbol, symbol, symbol];
        }

        if (roll < odds.jackpot + odds.small) {
            const pairSymbol = pickSlotSymbol(symbols, [], random);
            const singleSymbol = pickSlotSymbol(symbols, [pairSymbol], random);
            return shuffleSlotReels([pairSymbol, pairSymbol, singleSymbol], random);
        }

        const first = pickSlotSymbol(symbols, [], random);
        const second = pickSlotSymbol(symbols, [first], random);
        const third = pickSlotSymbol(symbols, [first, second], random);
        return shuffleSlotReels([first, second, third], random);
    }

    function classifySlotResult(reels) {
        if (!Array.isArray(reels) || reels.length !== 3) {
            throw new RangeError("角子机结果必须包含 3 个图案");
        }
        const counts = reels.reduce((map, symbol) => {
            map[symbol] = (map[symbol] || 0) + 1;
            return map;
        }, {});
        const maxCount = Math.max(...Object.values(counts));
        if (maxCount === 3) return reels[0] === "7️⃣" ? "seven" : "jackpot";
        if (maxCount === 2) return "small";
        return "miss";
    }

    function advanceSlotState(currentState, cfg, resultType) {
        let pressure = clamp(currentState?.pressure, 0, 100);
        let missStreak = Math.max(0, Math.round(Number(currentState?.missStreak) || 0));
        let message = "";
        let triggerPunishment = false;
        let deferFullPunishment = false;
        let punishmentReason = "压力满格";

        if (resultType === "miss") {
            missStreak += 1;
            const gain = Math.max(0, Number(cfg?.missGain) || 0) +
                Math.max(0, missStreak - 1) * Math.max(0, Number(cfg?.streakBonus) || 0);
            pressure = clamp(pressure + gain, 0, 100);
            message = `没中奖，压力 +${gain}%`;
        } else if (resultType === "small") {
            missStreak = Math.max(0, missStreak - 1);
            const drop = Math.max(0, Number(cfg?.smallWinDrop) || 0);
            pressure = clamp(pressure - drop, 0, 100);
            message = `小奖，压力 -${drop}%`;
        } else if (resultType === "jackpot") {
            missStreak = 0;
            const drop = Math.max(0, Number(cfg?.jackpotDrop) || 0);
            pressure = clamp(pressure - drop, 0, 100);
            message = `大奖，压力 -${drop}%`;
        } else if (resultType === "seven") {
            missStreak = 0;
            if (cfg?.sevenRule === "reset") {
                pressure = 0;
                message = "三个图标全是 7️⃣，压力清空";
            } else if (cfg?.sevenRule === "shock") {
                pressure = 100;
                triggerPunishment = true;
                punishmentReason = "7️⃣ × 3 特殊事件";
                message = "三个图标全是 7️⃣，立即执行满槽惩罚";
            } else {
                // “进入满槽”只制造下一局的危险，不在本局偷偷复用“立即惩罚”的效果。
                // 未知配置也走这条保守路径，损坏的本地设置不能意外升级成立即输出。
                pressure = 100;
                deferFullPunishment = true;
                message = "三个图标全是 7️⃣，进入满槽；本局不输出";
            }
        } else {
            throw new RangeError("未知角子机结算类型");
        }

        if (!deferFullPunishment && !triggerPunishment && pressure >= 100) {
            triggerPunishment = true;
        }
        return {
            pressure,
            missStreak,
            message,
            triggerPunishment,
            punishmentReason
        };
    }

    return {
        advanceSlotState,
        buildSlotResult,
        capPunishmentCount,
        clamp,
        classifySlotResult,
        estimateDiceQueueSeconds,
        evaluateDiceRound,
        formatSettingLabel,
        getSlotOdds,
        getTripleFace,
        hasSafeOutputLimits,
        isTimestampFresh,
        restoreSettings,
        shuffleSlotReels
    };
}));
