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

    function normalizeOutputSettings(defaultSettings, candidate) {
        // 全局输出配置会直接决定实际接通哪一路，损坏缓存不能靠“猜”来恢复。
        const normalized = { ...defaultSettings };
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
            return { settings: normalized, valid: false };
        }

        const outputMode = candidate.outputMode;
        const bStrengthMode = candidate.bStrengthMode;
        const bStrengthPercent = candidate.bStrengthPercent;
        const valid = ALLOWED_SETTING_VALUES.outputMode.has(outputMode) &&
            ALLOWED_SETTING_VALUES.bStrengthMode.has(bStrengthMode) &&
            typeof bStrengthPercent === "number" && Number.isFinite(bStrengthPercent) &&
            bStrengthPercent >= 10 && bStrengthPercent <= 100;

        if (!valid) {
            return { settings: normalized, valid: false };
        }

        normalized.outputMode = outputMode;
        normalized.bStrengthMode = bStrengthMode;
        normalized.bStrengthPercent = bStrengthPercent;
        return { settings: normalized, valid: true };
    }

    function resolveStoredGlobalOutputSettings(defaultSettings, savedSettings) {
        const normalized = normalizeOutputSettings(defaultSettings, savedSettings);
        return {
            settings: normalized.settings,
            // 明确保存过 confirmed=true 且三个输出字段都合法，才允许正式输出。
            requiresConfirmation: !normalized.valid || savedSettings?.confirmed !== true
        };
    }

    function migrateLegacyOutputSettings(defaultSettings, savedGameSettings, gameNames) {
        const names = Array.isArray(gameNames) ? gameNames : [];
        const savedRootValid = savedGameSettings && typeof savedGameSettings === "object" &&
            !Array.isArray(savedGameSettings);
        if (!savedRootValid || names.length === 0) {
            return {
                settings: { ...defaultSettings },
                requiresConfirmation: !savedRootValid
            };
        }

        const outputKeys = ["outputMode", "bStrengthMode", "bStrengthPercent"];
        let foundLegacyOutput = false;
        let allCandidatesValid = true;
        const candidates = names.map((gameName) => {
            const savedGame = savedGameSettings[gameName];
            const hasLegacyOutput = savedGame && typeof savedGame === "object" && !Array.isArray(savedGame) &&
                outputKeys.some((key) => Object.prototype.hasOwnProperty.call(savedGame, key));

            if (!hasLegacyOutput) {
                return { ...defaultSettings };
            }

            foundLegacyOutput = true;
            const normalized = normalizeOutputSettings(defaultSettings, savedGame);
            allCandidatesValid = allCandidatesValid && normalized.valid;
            return normalized.settings;
        });

        if (!foundLegacyOutput) {
            return { settings: { ...defaultSettings }, requiresConfirmation: false };
        }

        const first = candidates[0];
        const allEqual = candidates.every((candidate) =>
            outputKeys.every((key) => candidate[key] === first[key])
        );

        if (allCandidatesValid && allEqual) {
            return { settings: { ...first }, requiresConfirmation: false };
        }

        // 旧版四个游戏若接线选择互相冲突，宁可暂停输出，也不能擅自选择可能接错人的通道。
        return { settings: { ...defaultSettings }, requiresConfirmation: true };
    }

    function applyStandaloneShockDurationFloor(settings) {
        // 单次结算型惩罚低于 1 秒时真机体感不稳定；旧版缓存也必须在读取时自动迁移。
        // 骰子间隔、角子机休息以及持续型玩法的内部控制帧不是单次惩罚，不在这里修改。
        const normalized = cloneSettings(settings);
        const durationFields = [
            ["dice", "singleSeconds"],
            ["slot", "shockSeconds"],
            ["slot", "lightShockSeconds"]
        ];

        durationFields.forEach(([gameName, fieldName]) => {
            const game = normalized[gameName];
            if (!game) return;
            const duration = Number(game[fieldName]);
            game[fieldName] = Number.isFinite(duration) ? Math.max(1, duration) : 1;
        });
        return normalized;
    }

    function normalizeLightningSettings(candidate, defaults) {
        // 雷电极速允许玩家调节玩法节奏，但所有滑块都必须再次经过规则层收口。
        // 这样即使 localStorage 被旧版本或手工修改过，也无法绕过界面上的安全范围。
        const source = candidate && typeof candidate === "object" && !Array.isArray(candidate)
            ? candidate
            : {};
        const fallback = defaults && typeof defaults === "object" ? defaults : {};
        const startSpeed = clamp(source.startSpeed ?? fallback.startSpeed ?? 10, 5, 20);
        const startStrength = clamp(source.startStrength ?? fallback.startStrength ?? 20, 0, 100);
        const maxStrength = clamp(
            source.maxStrength ?? fallback.maxStrength ?? 80,
            startStrength,
            100
        );
        const fullSpeed = clamp(
            source.fullSpeed ?? fallback.fullSpeed ?? 50,
            startSpeed + 10,
            55
        );
        const jamGapMinSeconds = clamp(
            source.jamGapMinSeconds ?? fallback.jamGapMinSeconds ?? 12,
            10,
            60
        );
        const jamGapMaxSeconds = clamp(
            source.jamGapMaxSeconds ?? fallback.jamGapMaxSeconds ?? 25,
            jamGapMinSeconds + 5,
            120
        );

        return {
            startSpeed,
            startStrength,
            maxStrength,
            fullSpeed,
            continuousSeconds: clamp(
                source.continuousSeconds ?? fallback.continuousSeconds ?? 8,
                3,
                30
            ),
            drivingRestSeconds: clamp(
                source.drivingRestSeconds ?? fallback.drivingRestSeconds ?? 3,
                3,
                30
            ),
            overspeedRecoverySeconds: clamp(
                source.overspeedRecoverySeconds ?? fallback.overspeedRecoverySeconds ?? 10,
                0,
                10
            ),
            sessionMinutes: clamp(
                source.sessionMinutes ?? fallback.sessionMinutes ?? 10,
                1,
                30
            ),
            jamEnabled: typeof source.jamEnabled === "boolean"
                ? source.jamEnabled
                : Boolean(fallback.jamEnabled),
            jamStrength: clamp(
                source.jamStrength ?? fallback.jamStrength ?? 30,
                0,
                maxStrength
            ),
            jamEntrySeconds: clamp(
                source.jamEntrySeconds ?? fallback.jamEntrySeconds ?? 40,
                20,
                120
            ),
            jamShockSeconds: clamp(
                source.jamShockSeconds ?? fallback.jamShockSeconds ?? 1.5,
                1,
                20
            ),
            jamGapMinSeconds,
            jamGapMaxSeconds,
            jamBatchCount: Math.round(clamp(
                source.jamBatchCount ?? fallback.jamBatchCount ?? 5,
                1,
                10
            )),
            jamBatchRestSeconds: clamp(
                source.jamBatchRestSeconds ?? fallback.jamBatchRestSeconds ?? 60,
                30,
                180
            )
        };
    }

    function calculateLightningStrength(speedKmh, settings) {
        const cfg = normalizeLightningSettings(settings, settings);
        const speed = Number(speedKmh);
        if (!Number.isFinite(speed) || speed < cfg.startSpeed || speed >= 60) return 0;

        if (speed <= cfg.fullSpeed) {
            const range = Math.max(1, cfg.fullSpeed - cfg.startSpeed);
            const ratio = clamp((speed - cfg.startSpeed) / range, 0, 1);
            return Math.round(cfg.startStrength + (cfg.maxStrength - cfg.startStrength) * ratio);
        }

        if (speed <= 55) return Math.round(cfg.maxStrength);

        // 55 km/h 后不再奖励继续提速，而是逐步回落到起始强度；到 60 km/h 由状态机硬停止。
        const protectionRatio = clamp((speed - 55) / 5, 0, 1);
        return Math.round(cfg.maxStrength - (cfg.maxStrength - cfg.startStrength) * protectionRatio);
    }

    function createLightningState(now = Date.now()) {
        const startedAt = Number.isFinite(Number(now)) ? Number(now) : Date.now();
        return {
            mode: "waiting_speed",
            modeSince: startedAt,
            sessionStartedAt: startedAt,
            startCandidateSince: null,
            lowSince: null,
            overspeedRecoverySince: null,
            overspeedLatched: false,
            lastSpeedKmh: null
        };
    }

    function advanceLightningState(currentState, rawSettings, sample, now = Date.now()) {
        const cfg = normalizeLightningSettings(rawSettings, rawSettings);
        const currentTime = Number(now);
        const state = {
            ...createLightningState(currentTime),
            ...(currentState || {})
        };
        const previousMode = state.mode;
        const speed = Number(sample?.speedKmh);
        const sampleAt = Number(sample?.timestamp);
        const sampleValid = sample?.valid === true && Number.isFinite(speed) && speed >= 0 && speed <= 250 &&
            isTimestampFresh(sampleAt, 3000, currentTime);
        let nextMode = previousMode;
        let shouldStop = false;

        if (currentTime - state.sessionStartedAt >= cfg.sessionMinutes * 60_000) {
            nextMode = "session_complete";
            shouldStop = previousMode !== "session_complete";
        } else if (!sampleValid) {
            nextMode = "gps_blocked";
            shouldStop = previousMode !== "gps_blocked";
            state.startCandidateSince = null;
            state.lowSince = null;
            state.overspeedRecoverySince = null;
        } else if (speed >= 60) {
            nextMode = "overspeed";
            shouldStop = previousMode !== "overspeed";
            state.overspeedLatched = true;
            state.startCandidateSince = null;
            state.lowSince = null;
            state.overspeedRecoverySince = null;
        } else if (state.overspeedLatched) {
            nextMode = "overspeed";
            if (state.overspeedRecoverySince === null) {
                state.overspeedRecoverySince = currentTime;
            }
            const recoveryMs = cfg.overspeedRecoverySeconds * 1000;
            if (currentTime - state.overspeedRecoverySince >= recoveryMs) {
                state.overspeedLatched = false;
                state.overspeedRecoverySince = null;
                state.lowSince = speed < cfg.startSpeed ? currentTime : null;
                state.startCandidateSince = speed >= cfg.startSpeed ? currentTime - 2000 : null;
                nextMode = speed >= cfg.startSpeed ? "driving" : "low_pending";
            }
        } else {
            // 启动线本身也是停止线：只要低于用户设定值就先停，不能用迟滞区继续带电。
            // 恢复时再额外要求高出 1 km/h 并稳定 2 秒，避免 GPS 在边界附近抖动反复切换。
            const enterLowSpeed = cfg.startSpeed;
            const resumeSpeed = Math.min(59.9, cfg.startSpeed + 1);
            const isLowMode = ["low_pending", "low_paused", "jam"].includes(previousMode);
            const isWaitingMode = ["waiting_speed", "gps_blocked", "session_complete"].includes(previousMode);

            if (previousMode === "driving" && speed < enterLowSpeed) {
                state.lowSince = currentTime;
                state.startCandidateSince = null;
                nextMode = "low_pending";
                shouldStop = true;
            } else if (previousMode === "driving") {
                nextMode = "driving";
            } else if (isLowMode) {
                if (speed >= resumeSpeed) {
                    if (state.startCandidateSince === null) state.startCandidateSince = currentTime;
                    if (previousMode === "jam") {
                        // 一旦载具恢复移动，堵车输出立刻停；稳定确认期间保持无输出，不能等两秒后才停。
                        nextMode = "low_pending";
                        shouldStop = true;
                    }
                    if (currentTime - state.startCandidateSince >= 2000) {
                        nextMode = "driving";
                        state.lowSince = null;
                        state.startCandidateSince = null;
                    }
                } else {
                    state.startCandidateSince = null;
                    if (state.lowSince === null) state.lowSince = currentTime;
                    const lowElapsed = currentTime - state.lowSince;
                    if (cfg.jamEnabled && lowElapsed >= cfg.jamEntrySeconds * 1000) {
                        nextMode = "jam";
                    } else if (lowElapsed >= 5000) {
                        nextMode = "low_paused";
                    } else {
                        nextMode = "low_pending";
                    }
                }
            } else if (isWaitingMode) {
                if (speed >= cfg.startSpeed) {
                    if (state.startCandidateSince === null) state.startCandidateSince = currentTime;
                    if (currentTime - state.startCandidateSince >= 2000) {
                        nextMode = "driving";
                        state.startCandidateSince = null;
                    } else {
                        nextMode = "waiting_speed";
                    }
                } else {
                    state.startCandidateSince = null;
                    nextMode = "waiting_speed";
                }
            }
        }

        if (nextMode !== previousMode) state.modeSince = currentTime;
        state.mode = nextMode;
        state.lastSpeedKmh = sampleValid ? speed : null;

        return {
            state,
            shouldStop,
            strength: nextMode === "driving" ? calculateLightningStrength(speed, cfg) : 0,
            sampleValid
        };
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

    function calculateDiceExecutionPlan(rawCount, cfg, outputBudgetSeconds = 300) {
        // 骰子规则理论上最多产生 6 点豹子 × 6 倍 = 36 下。这里仍同时尊重玩家
        // 自己设置的次数上限与单局累计输出预算，防止长时设置意外突破 300 秒。
        const singleSeconds = clamp(cfg?.singleSeconds ?? 1, 1, 30);
        const maximumCount = Math.round(clamp(cfg?.maxPunishCount ?? 30, 1, 36));
        const ruleCount = Math.max(0, Math.round(Number(rawCount) || 0));
        const budgetSeconds = Math.max(0, Number(outputBudgetSeconds) || 0);
        const budgetCount = Math.floor(budgetSeconds / singleSeconds);
        const executionCount = Math.min(ruleCount, maximumCount, budgetCount);

        return {
            ruleCount,
            maximumCount,
            budgetCount,
            executionCount,
            singleSeconds,
            outputSeconds: executionCount * singleSeconds,
            truncated: executionCount < ruleCount
        };
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
        if (id.startsWith("lightning-") && id.endsWith("seconds")) {
            return `${safeValue.toFixed(1)}s`;
        }
        if (id === "lightning-session-minutes") {
            return `${safeValue} 分钟`;
        }
        if (id === "lightning-start-speed" || id === "lightning-full-speed") {
            return `${safeValue} km/h`;
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

    function getEffectiveBaseStrengthLimit(mode, limitA, limitB, bStrengthMode, bStrengthPercent) {
        // 游戏只设置一份“基础强度”。B 为比例模式时，需要先把 B 的硬件上限反推成基础强度上限。
        if (!["a", "b", "ab"].includes(mode)) return 0;
        const safeA = Math.floor(clamp(limitA, 0, 200));
        const safeB = Math.floor(clamp(limitB, 0, 200));
        let bBaseLimit = safeB;
        if (mode !== "a") {
            if (!["same", "percent"].includes(bStrengthMode)) return 0;
            if (bStrengthMode === "percent") {
                const percent = clamp(bStrengthPercent, 10, 100);
                bBaseLimit = Math.min(200, Math.floor((safeB * 100) / percent));
            }
        }
        if (mode === "a") return safeA;
        if (mode === "b") return bBaseLimit;
        return Math.min(safeA, bBaseLimit);
    }

    function clampGameStrengthSettings(settings, maximumStrength) {
        const limit = Math.floor(clamp(maximumStrength, 0, 200));
        const result = {};
        Object.entries(settings && typeof settings === "object" ? settings : {}).forEach(([gameName, game]) => {
            result[gameName] = game && typeof game === "object" && !Array.isArray(game)
                ? { ...game }
                : game;
        });

        const fields = {
            shake: ["strengthMin", "strengthMax"],
            dice: ["strength"],
            slot: ["strengthMin", "strengthMax"],
            lightning: ["startStrength", "maxStrength", "jamStrength"]
        };
        Object.entries(fields).forEach(([gameName, names]) => {
            const game = result[gameName];
            if (!game || typeof game !== "object") return;
            names.forEach((name) => {
                if (Object.hasOwn(game, name)) {
                    game[name] = Math.round(clamp(game[name], 0, limit));
                }
            });
        });

        ["shake", "slot"].forEach((gameName) => {
            const game = result[gameName];
            if (game && game.strengthMin > game.strengthMax) {
                game.strengthMin = game.strengthMax;
            }
        });
        const lightning = result.lightning;
        if (lightning) {
            if (lightning.startStrength > lightning.maxStrength) {
                lightning.startStrength = lightning.maxStrength;
            }
            if (lightning.jamStrength > lightning.maxStrength) {
                lightning.jamStrength = lightning.maxStrength;
            }
        }
        return result;
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
        calculateDiceExecutionPlan,
        clamp,
        classifySlotResult,
        estimateDiceQueueSeconds,
        evaluateDiceRound,
        formatSettingLabel,
        getEffectiveBaseStrengthLimit,
        getSlotOdds,
        getTripleFace,
        hasSafeOutputLimits,
        clampGameStrengthSettings,
        isTimestampFresh,
        advanceLightningState,
        applyStandaloneShockDurationFloor,
        calculateLightningStrength,
        createLightningState,
        migrateLegacyOutputSettings,
        normalizeLightningSettings,
        resolveStoredGlobalOutputSettings,
        restoreSettings,
        shuffleSlotReels
    };
}));
