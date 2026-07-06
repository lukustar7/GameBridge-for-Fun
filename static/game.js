/* 手机小游戏端交互逻辑 game.js */

// --- 1. 全局连接与页面状态 ---

let ws = null;
let latencyTimer = null;
let reconnectTimer = null;
let suppressReconnect = false;

const urlParams = new URLSearchParams(window.location.search);
const pinnedWsPort = parseInt(urlParams.get("ws"), 10);
const hasPinnedWsPort = Number.isInteger(pinnedWsPort) && pinnedWsPort >= 1 && pinnedWsPort <= 65535;
const gameToken = urlParams.get("token") || "";
let currentWsPort = hasPinnedWsPort ? pinnedWsPort : 18081;
let triedPortsCount = 0;
const maxPortPortion = 10;

// selectedGame 是设置页当前选中的游戏；activeGame 是已经真正开始运行的游戏。
let selectedGame = null;
let activeGame = null;

// 统一保存四套游戏配置，避免一个游戏的强度和玩法参数串到另一个游戏。
const SETTINGS_STORAGE_KEY = "dg_lab_game_settings_v2";
const DEFAULT_SETTINGS = {
    shake: {
        strengthMin: 20,
        strengthMax: 60,
        mode: "radius",
        safeRadius: 26,
        gapInner: 12,
        sensitivity: 55,
        forgiveMs: 600
    },
    angle: {
        strengthMin: 15,
        strengthMax: 70,
        targetOffset: 0,
        tolerance: 8,
        triggerMs: 800,
        rampDegrees: 28
    },
    dice: {
        strengthMin: 20,
        strengthMax: 80,
        timeMin: 1.0,
        timeMax: 4.0,
        shakeSensitivity: 15,
        opponentDifficulty: "normal",
        manualRoll: true,
        leopardSecondsPerPoint: 5
    },
    slot: {
        strengthMin: 20,
        strengthMax: 85,
        shockSeconds: 2.0,
        spinMs: 700,
        autoSpin: false,
        autoIntervalMs: 650,
        missGain: 24,
        streakBonus: 6,
        smallWinDrop: 14,
        jackpotDrop: 70,
        winRate: "normal",
        sevenRule: "fill"
    }
};

const GAME_META = {
    shake: {
        title: "手抖挑战",
        subtitle: "设置弹珠安全区、倾斜灵敏度和出界后的宽容时间。",
        help: "保持弹珠停在安全区内。离开安全区超过宽容时间后，偏离越远，惩罚越强。",
        toleranceLabel: (cfg) => cfg.mode === "gap" ? `夹缝 ${cfg.gapInner}% / ${cfg.safeRadius}%` : `半径 ${cfg.safeRadius}%`,
        triggerLabel: (cfg) => `${cfg.forgiveMs}ms 后触发`
    },
    angle: {
        title: "保持角度",
        subtitle: "以校准姿态为基准，设置目标角度、允许误差和持续偏离时间。",
        help: "以开始时的握持姿态为基准。持续偏离目标角度才会触发，短暂晃动不会立刻结算。",
        toleranceLabel: (cfg) => `目标 ${cfg.targetOffset}° ± ${cfg.tolerance}°`,
        triggerLabel: (cfg) => `${cfg.triggerMs}ms 后触发`
    },
    dice: {
        title: "摇骰子对决",
        subtitle: "设置摇晃灵敏度、对手难度和失败后的惩罚区间。",
        help: "摇晃越充分，玩家骰子越有优势。任意一方摇出豹子时直接触发豹子惩罚。",
        toleranceLabel: (cfg) => `灵敏度 ${cfg.shakeSensitivity}`,
        triggerLabel: (cfg) => `失败 ${cfg.timeMin.toFixed(1)}s-${cfg.timeMax.toFixed(1)}s | 豹子 ${cfg.leopardSecondsPerPoint}s/点`
    },
    slot: {
        title: "极速角子机",
        subtitle: "设置开奖速度、中奖概率、压力进度和满槽惩罚。",
        help: "三格 Emoji 高频开奖。全不同会增加压力，两个或三个相同会回落；压力条满格后立即触发惩罚。",
        toleranceLabel: (cfg) => `空转 +${cfg.missGain}% | 小奖 -${cfg.smallWinDrop}%`,
        triggerLabel: (cfg) => `${cfg.spinMs}ms 开奖 | 满槽 ${cfg.shockSeconds.toFixed(1)}s`
    }
};

let gameSettings = loadSettings();

// --- 2. 传感器、画布与游戏运行状态 ---

let sensorsAllowed = false;
let sensorsBound = false;
let orientationReady = false;
let motionReady = false;
let phoneBeta = 0;   // 前后倾斜，单位为度。
let phoneGamma = 0;  // 左右倾斜，单位为度。
let shakeAcc = 0;    // 三轴加速度合成值，摇骰子时用于判断晃动强度。

let canvas = null;
let ctx = null;
let animationFrameId = null;
let gameLoopTimer = null;
let gameStartedAt = 0;
let lastPulseAt = 0;
let lastVibrateAt = 0;

// 校准值只保存当前会话。玩家每次开始游戏时也会自动用当前姿态兜底校准。
const calibration = {
    shakeBeta: 0,
    shakeGamma: 0,
    angleBeta: 0
};

// 手抖挑战状态。
let ballX = 0;
let ballY = 0;
let ballVx = 0;
let ballVy = 0;
let shakeOutSince = null;
const ballRadius = 8;

// 保持角度状态。
let angleBadSince = null;

// 摇骰子状态。
let audioCtx = null;
let isDiceShaking = false;
let lastShakeTime = 0;
let diceShakeEnergy = 0;
let shakeStopTimeout = null;
let manualRollTimer = null;
let wakeLock = null;
let latestGameLatency = null;

// 极速角子机状态。
const SLOT_SYMBOLS = ["🍒", "🍋", "🍇", "🔔", "⭐", "💎", "7️⃣", "🎰"];
let slotPressure = 0;
let slotMissStreak = 0;
let slotIsSpinning = false;
let slotSpinAnimationTimer = null;
let slotSpinFinishTimer = null;
let slotAutoTimer = null;
let slotCooldownTimer = null;
let slotCooldownUntil = 0;

function $(id) {
    return document.getElementById(id);
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function readNumber(id, fallback = 0) {
    const value = parseFloat($(id).value);
    return Number.isFinite(value) ? value : fallback;
}

function setText(id, value) {
    const node = $(id);
    if (node) {
        node.innerText = value;
    }
}

function loadSettings() {
    try {
        const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return {
            shake: { ...DEFAULT_SETTINGS.shake, ...(parsed.shake || {}) },
            angle: { ...DEFAULT_SETTINGS.angle, ...(parsed.angle || {}) },
            dice: { ...DEFAULT_SETTINGS.dice, ...(parsed.dice || {}) },
            slot: { ...DEFAULT_SETTINGS.slot, ...(parsed.slot || {}) }
        };
    } catch (error) {
        console.warn("读取本地游戏设置失败，已回退默认值:", error);
        return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    }
}

function persistSettings() {
    try {
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(gameSettings));
    } catch (error) {
        console.warn("保存本地游戏设置失败:", error);
    }
}

// --- 3. WebSocket 网络连接与心跳延迟监控 ---

function connectWebSocket() {
    const host = window.location.hostname || "127.0.0.1";
    const tokenQuery = gameToken ? `?token=${encodeURIComponent(gameToken)}` : "";
    const targetUrl = `ws://${host}:${currentWsPort}/game${tokenQuery}`;

    suppressReconnect = false;
    clearTimeout(reconnectTimer);
    ws = new WebSocket(targetUrl);

    ws.onopen = () => {
        console.log(`游戏端连接成功: ${targetUrl}`);
        triedPortsCount = 0;
        setText("tech-game-status", "已连接");
        setText("ping-badge", "网速延迟: --ms");

        clearInterval(latencyTimer);
        latencyTimer = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: "ping",
                    time: Date.now()
                }));
            }
        }, 1000);
    };

    ws.onmessage = (event) => {
        let data = null;
        try {
            data = JSON.parse(event.data);
        } catch (error) {
            console.warn("收到无法解析的服务端消息:", event.data);
            return;
        }

        if (data.type === "pong") {
            const rtt = Date.now() - data.time;
            latestGameLatency = rtt;
            setText("ping-badge", `网速延迟: ${rtt}ms`);
            updateLocalGameLatency();

            sendGameMessage({
                type: "latency_report",
                rtt
            });
        } else if (data.type === "state_update") {
            updateTechStatus(data);
        } else if (data.type === "button_feedback") {
            vibrateBriefly(20);
        }
    };

    ws.onclose = () => {
        clearInterval(latencyTimer);
        latestGameLatency = null;
        setText("ping-badge", "网速延迟: 离线");
        setText("tech-game-status", "离线");
        updateLocalGameLatency();

        if (suppressReconnect) {
            return;
        }

        if (hasPinnedWsPort) {
            reconnectTimer = setTimeout(connectWebSocket, 2000);
            return;
        }

        // 没有从二维码拿到明确 WS 端口时，保留 10 个端口的自动探测兜底。
        if (triedPortsCount < maxPortPortion) {
            triedPortsCount++;
            currentWsPort = 18081 + (triedPortsCount % maxPortPortion);
            reconnectTimer = setTimeout(connectWebSocket, 120);
        } else {
            reconnectTimer = setTimeout(() => {
                triedPortsCount = 0;
                currentWsPort = 18081;
                connectWebSocket();
            }, 2000);
        }
    };

    ws.onerror = () => {
        ws.close();
    };
}

function sendGameMessage(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
        return true;
    }
    return false;
}

function formatLatency(value) {
    const latency = Number(value);
    if (!Number.isFinite(latency) || latency < 0) return "-";
    return `${Math.round(latency)}ms`;
}

function formatBatteryLevel(level) {
    if (level === null || level === undefined || level === "") return "未接入";
    const value = Number(level);
    if (!Number.isFinite(value)) return "未接入";
    return `${Math.round(value)}%`;
}

function formatHardwareReading(value, appConnected) {
    const number = Number(value);
    if (!appConnected || !Number.isFinite(number)) return "未读取";
    return String(number);
}

function updateLocalGameLatency() {
    setText("tech-game-latency", formatLatency(latestGameLatency));
}

function updateTechStatus(data) {
    const appConnected = Boolean(data.app_connected);

    // 选择页的技术状态用于现场排障：端口、连接、延迟和硬件回读统一放在这里。
    setText("tech-local-ip", data.local_ip || window.location.hostname || "-");
    setText("tech-http-port", data.http_port || "-");
    setText("tech-web-ws-port", data.web_ws_port || currentWsPort || "-");
    setText("tech-app-ws-port", data.app_ws_port || "-");
    setText("tech-app-status", appConnected ? "已绑定" : "等待绑定");
    setText("tech-game-status", data.game_connected ? "已连接" : "未连接");
    setText("tech-app-latency", formatLatency(data.app_latency));
    const shownGameLatency = latestGameLatency !== null ? latestGameLatency : data.game_latency;
    setText("tech-game-latency", formatLatency(shownGameLatency));
    setText("tech-strength-a", formatHardwareReading(data.strength_a, appConnected));
    setText("tech-strength-b", formatHardwareReading(data.strength_b, appConnected));
    setText("tech-limit-a", formatHardwareReading(data.limit_a, appConnected));
    setText("tech-limit-b", formatHardwareReading(data.limit_b, appConnected));
    setText("tech-battery", formatBatteryLevel(data.battery_level));
}

function closeGameSocketForEmergency() {
    suppressReconnect = true;
    clearTimeout(reconnectTimer);
    clearInterval(latencyTimer);

    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        try {
            ws.close(1000, "emergency stop");
        } catch (error) {
            console.warn("关闭游戏 WebSocket 失败:", error);
        }
    }
}

async function requestScreenWakeLock() {
    if (!("wakeLock" in navigator) || wakeLock) return;

    try {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => {
            wakeLock = null;
        });
    } catch (error) {
        console.warn("屏幕常亮请求失败，当前浏览器可能不支持 Wake Lock:", error);
    }
}

async function releaseScreenWakeLock() {
    if (!wakeLock) return;

    try {
        await wakeLock.release();
    } catch (error) {
        console.warn("释放屏幕常亮锁失败:", error);
    } finally {
        wakeLock = null;
    }
}

function emergencyStop(reason) {
    if (!activeGame && !isDiceShaking) return;

    stopRuntimeLoops();
    activeGame = null;
    isDiceShaking = false;
    slotIsSpinning = false;
    slotCooldownUntil = 0;
    sendGameMessage({
        type: "stop_shock",
        reason
    });
    closeGameSocketForEmergency();
    releaseScreenWakeLock();
    setText("game-status", "已紧急停止");
}

function bindEmergencyStopEvents() {
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            emergencyStop("page_hidden");
            return;
        }

        if (suppressReconnect) {
            suppressReconnect = false;
        }

        if (!ws || ws.readyState === WebSocket.CLOSED) {
            connectWebSocket();
        }
    });

    window.addEventListener("pagehide", () => emergencyStop("page_hide"));
    window.addEventListener("beforeunload", () => emergencyStop("before_unload"));

    // Safari 和部分 Chromium 内核会在页面冻结前触发 freeze；能收到就直接停。
    document.addEventListener("freeze", () => emergencyStop("page_freeze"));
}

// --- 4. 传感器授权、绑定与音频初始化 ---

async function requestSensorPermission() {
    if (sensorsAllowed) return true;

    if (typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function") {
        try {
            const permissionState = await DeviceOrientationEvent.requestPermission();
            sensorsAllowed = permissionState === "granted";
            return sensorsAllowed;
        } catch (error) {
            console.error("传感器授权失败:", error);
            return false;
        }
    }

    sensorsAllowed = true;
    return true;
}

function bindSensors() {
    if (sensorsBound) return;
    sensorsBound = true;

    window.addEventListener("deviceorientation", handleOrientation);
    window.addEventListener("devicemotion", handleMotion);
}

function handleOrientation(event) {
    phoneBeta = Number.isFinite(event.beta) ? event.beta : 0;
    phoneGamma = Number.isFinite(event.gamma) ? event.gamma : 0;
    orientationReady = true;
}

function handleMotion(event) {
    const acc = event.acceleration || event.accelerationIncludingGravity;
    if (!acc) return;

    const x = acc.x || 0;
    const y = acc.y || 0;
    const z = acc.z || 0;
    shakeAcc = Math.sqrt(x * x + y * y + z * z);
    motionReady = true;

    const cfg = gameSettings.dice;
    if (activeGame === "dice" && shakeAcc > cfg.shakeSensitivity) {
        triggerDiceShake(shakeAcc);
    }
}

function initAudio() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
}

function unlockAudio() {
    initAudio();
    if (audioCtx && audioCtx.state === "suspended") {
        audioCtx.resume();
    }
}

function playDiceCollisionSound() {
    /*
       使用 Web Audio API 即时合成短促碰撞音。这样不依赖外部音频文件，
       手机弱网或离线时也不会出现资源加载失败导致的静音。
    */
    if (!audioCtx) return;

    const now = audioCtx.currentTime;
    const bufferSize = audioCtx.sampleRate * 0.08;
    const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
    }

    const noiseNode = audioCtx.createBufferSource();
    const filter = audioCtx.createBiquadFilter();
    const noiseGain = audioCtx.createGain();
    noiseNode.buffer = buffer;
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(1000, now);
    filter.Q.setValueAtTime(3.0, now);
    noiseGain.gain.setValueAtTime(0.05, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    noiseNode.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(audioCtx.destination);
    noiseNode.start(now);

    const osc = audioCtx.createOscillator();
    const oscGain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(150 + Math.random() * 80, now);
    oscGain.gain.setValueAtTime(0.22, now);
    oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
    osc.connect(oscGain);
    oscGain.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.06);
}

// --- 5. 设置页流程 ---

function showScreen(screenId) {
    document.querySelectorAll(".screen").forEach((node) => {
        node.classList.remove("active");
    });
    $(screenId).classList.add("active");
    window.scrollTo(0, 0);
}

function showSelectScreen() {
    selectedGame = null;
    stopRuntimeLoops();
    showScreen("screen-select");
}

function openGameSettings(gameName) {
    selectedGame = gameName;
    activeGame = null;
    stopRuntimeLoops();

    document.querySelectorAll(".setting-panel").forEach((node) => {
        node.classList.remove("active");
    });
    $(`settings-${gameName}`).classList.add("active");

    setText("settings-title", GAME_META[gameName].title);
    setText("settings-subtitle", GAME_META[gameName].subtitle);
    setText("settings-message", "");
    populateSettingsForm(gameName);
    showScreen("screen-settings");
}

function populateSettingsForm(gameName) {
    const cfg = gameSettings[gameName];

    if (gameName === "shake") {
        $("shake-mode").value = cfg.mode;
        setRangeValue("shake-strength-min", cfg.strengthMin);
        setRangeValue("shake-strength-max", cfg.strengthMax);
        setRangeValue("shake-safe-radius", cfg.safeRadius);
        setRangeValue("shake-gap-inner", cfg.gapInner);
        setRangeValue("shake-sensitivity", cfg.sensitivity);
        setRangeValue("shake-forgive-ms", cfg.forgiveMs);
    } else if (gameName === "angle") {
        setRangeValue("angle-strength-min", cfg.strengthMin);
        setRangeValue("angle-strength-max", cfg.strengthMax);
        setRangeValue("angle-target-offset", cfg.targetOffset);
        setRangeValue("angle-tolerance", cfg.tolerance);
        setRangeValue("angle-trigger-ms", cfg.triggerMs);
        setRangeValue("angle-ramp-degrees", cfg.rampDegrees);
    } else if (gameName === "dice") {
        setRangeValue("dice-strength-min", cfg.strengthMin);
        setRangeValue("dice-strength-max", cfg.strengthMax);
        setRangeValue("dice-time-min", cfg.timeMin);
        setRangeValue("dice-time-max", cfg.timeMax);
        setRangeValue("dice-shake-sensitivity", cfg.shakeSensitivity);
        setRangeValue("dice-leopard-seconds-per-point", cfg.leopardSecondsPerPoint);
        $("dice-opponent-difficulty").value = cfg.opponentDifficulty;
        $("dice-manual-roll").checked = cfg.manualRoll;
    } else if (gameName === "slot") {
        setRangeValue("slot-strength-min", cfg.strengthMin);
        setRangeValue("slot-strength-max", cfg.strengthMax);
        setRangeValue("slot-shock-seconds", cfg.shockSeconds);
        setRangeValue("slot-spin-ms", cfg.spinMs);
        setRangeValue("slot-auto-interval-ms", cfg.autoIntervalMs);
        setRangeValue("slot-miss-gain", cfg.missGain);
        setRangeValue("slot-streak-bonus", cfg.streakBonus);
        setRangeValue("slot-small-win-drop", cfg.smallWinDrop);
        setRangeValue("slot-jackpot-drop", cfg.jackpotDrop);
        $("slot-auto-spin").checked = cfg.autoSpin;
        $("slot-win-rate").value = cfg.winRate;
        $("slot-seven-rule").value = cfg.sevenRule;
    }
}

function setRangeValue(id, value) {
    $(id).value = value;
    updateSettingValue(id, false);
}

function updateSettingValue(id, shouldSave = true) {
    const rawValue = readNumber(id, 0);
    let label = String(rawValue);

    if (id.endsWith("safe-radius") || id.endsWith("gap-inner") ||
        id.endsWith("miss-gain") || id.endsWith("streak-bonus") ||
        id.endsWith("small-win-drop") || id.endsWith("jackpot-drop")) {
        label = `${rawValue}%`;
    } else if (id.endsWith("forgive-ms") || id.endsWith("trigger-ms") ||
        id.endsWith("spin-ms") || id.endsWith("auto-interval-ms")) {
        label = `${rawValue}ms`;
    } else if (id.endsWith("seconds-per-point")) {
        label = `${rawValue}s`;
    } else if (id.endsWith("shock-seconds")) {
        label = `${rawValue.toFixed(1)}s`;
    } else if (id.includes("time-")) {
        label = `${rawValue.toFixed(1)}s`;
    } else if (id.includes("angle-") || id.endsWith("ramp-degrees")) {
        label = `${rawValue}°`;
    }

    setText(`val-${id}`, label);

    if (shouldSave) {
        saveSelectedSettings(true);
    }
}

function saveSelectedSettings(silent = false) {
    if (!selectedGame) return;

    const cfg = collectSettingsFromForm(selectedGame);
    gameSettings[selectedGame] = cfg;
    persistSettings();
    populateSettingsForm(selectedGame);

    if (!silent) {
        setText("settings-message", "设置已保存");
    }
}

function collectSettingsFromForm(gameName) {
    if (gameName === "shake") {
        const minStrength = clamp(readNumber("shake-strength-min", 20), 0, 200);
        const maxStrength = clamp(readNumber("shake-strength-max", 60), 0, 200);
        return {
            strengthMin: Math.min(minStrength, maxStrength),
            strengthMax: Math.max(minStrength, maxStrength),
            mode: $("shake-mode").value,
            safeRadius: clamp(readNumber("shake-safe-radius", 26), 12, 45),
            gapInner: clamp(readNumber("shake-gap-inner", 12), 6, 28),
            sensitivity: clamp(readNumber("shake-sensitivity", 55), 20, 100),
            forgiveMs: clamp(readNumber("shake-forgive-ms", 600), 0, 2000)
        };
    }

    if (gameName === "angle") {
        const minStrength = clamp(readNumber("angle-strength-min", 15), 0, 200);
        const maxStrength = clamp(readNumber("angle-strength-max", 70), 0, 200);
        return {
            strengthMin: Math.min(minStrength, maxStrength),
            strengthMax: Math.max(minStrength, maxStrength),
            targetOffset: clamp(readNumber("angle-target-offset", 0), -45, 45),
            tolerance: clamp(readNumber("angle-tolerance", 8), 2, 30),
            triggerMs: clamp(readNumber("angle-trigger-ms", 800), 100, 2500),
            rampDegrees: clamp(readNumber("angle-ramp-degrees", 28), 5, 60)
        };
    }

    if (gameName === "dice") {
        const minStrength = clamp(readNumber("dice-strength-min", 20), 0, 200);
        const maxStrength = clamp(readNumber("dice-strength-max", 80), 0, 200);
        const timeMin = clamp(readNumber("dice-time-min", 1), 0.5, 10);
        const timeMax = clamp(readNumber("dice-time-max", 4), 0.5, 10);
        return {
            strengthMin: Math.min(minStrength, maxStrength),
            strengthMax: Math.max(minStrength, maxStrength),
            timeMin: Math.min(timeMin, timeMax),
            timeMax: Math.max(timeMin, timeMax),
            shakeSensitivity: clamp(readNumber("dice-shake-sensitivity", 15), 8, 35),
            leopardSecondsPerPoint: clamp(readNumber("dice-leopard-seconds-per-point", 5), 1, 10),
            opponentDifficulty: $("dice-opponent-difficulty").value,
            manualRoll: $("dice-manual-roll").checked
        };
    }

    if (gameName === "slot") {
        const minStrength = clamp(readNumber("slot-strength-min", 20), 0, 200);
        const maxStrength = clamp(readNumber("slot-strength-max", 85), 0, 200);
        return {
            strengthMin: Math.min(minStrength, maxStrength),
            strengthMax: Math.max(minStrength, maxStrength),
            shockSeconds: clamp(readNumber("slot-shock-seconds", 2.0), 0.5, 8.0),
            spinMs: clamp(readNumber("slot-spin-ms", 700), 450, 1400),
            autoSpin: $("slot-auto-spin").checked,
            autoIntervalMs: clamp(readNumber("slot-auto-interval-ms", 650), 300, 1800),
            missGain: clamp(readNumber("slot-miss-gain", 24), 8, 45),
            streakBonus: clamp(readNumber("slot-streak-bonus", 6), 0, 15),
            smallWinDrop: clamp(readNumber("slot-small-win-drop", 14), 0, 35),
            jackpotDrop: clamp(readNumber("slot-jackpot-drop", 70), 20, 100),
            winRate: $("slot-win-rate").value,
            sevenRule: $("slot-seven-rule").value
        };
    }

    return { ...DEFAULT_SETTINGS[gameName] };
}

function calibrateCurrentPose(gameName) {
    if (!orientationReady) {
        setText("settings-message", "传感器尚未回传姿态，开始游戏时会自动校准");
        return;
    }

    if (gameName === "shake") {
        calibration.shakeBeta = phoneBeta;
        calibration.shakeGamma = phoneGamma;
    } else if (gameName === "angle") {
        calibration.angleBeta = phoneBeta;
    }

    setText("settings-message", "已使用当前握持姿态作为基准");
}

async function startConfiguredGame() {
    if (!selectedGame) return;

    saveSelectedSettings(true);
    const needsSensors = selectedGame === "shake" || selectedGame === "angle" || selectedGame === "dice";
    if (needsSensors) {
        const allowed = await requestSensorPermission();
        if (!allowed) {
            setText("settings-message", "需要允许运动与方向感应权限");
            return;
        }

        bindSensors();
    }

    if (selectedGame === "dice") {
        unlockAudio();
    }
    requestScreenWakeLock();

    activeGame = selectedGame;
    gameStartedAt = Date.now();
    lastPulseAt = 0;
    shakeOutSince = null;
    angleBadSince = null;

    // 每次开始时自动用当前姿态兜底校准，避免玩家刚进入就因为初始握法被误罚。
    if (activeGame === "shake") {
        calibration.shakeBeta = phoneBeta;
        calibration.shakeGamma = phoneGamma;
    } else if (activeGame === "angle") {
        calibration.angleBeta = phoneBeta;
    }

    setupPlayScreen(activeGame);
    showScreen("screen-play");
}

function setupPlayScreen(gameName) {
    const cfg = gameSettings[gameName];
    setText("game-title", GAME_META[gameName].title);
    setText("game-help", GAME_META[gameName].help);
    setText("summary-game", GAME_META[gameName].title);
    setText("summary-strength-min", cfg.strengthMin);
    setText("summary-strength-max", cfg.strengthMax);
    setText("summary-tolerance", GAME_META[gameName].toleranceLabel(cfg));
    setText("summary-trigger", GAME_META[gameName].triggerLabel(cfg));

    $("game-viewport").style.display = gameName === "dice" || gameName === "slot" ? "none" : "block";
    $("dice-viewport").style.display = gameName === "dice" ? "block" : "none";
    $("slot-viewport").style.display = gameName === "slot" ? "block" : "none";

    stopRuntimeLoops();

    if (gameName === "shake") {
        setText("game-status", "保持弹珠停留在安全区内");
        initShakeGame();
    } else if (gameName === "angle") {
        setText("game-status", "保持当前姿态附近的目标角度");
        initAngleGame();
    } else if (gameName === "dice") {
        setText("game-status", motionReady ? "摇晃手机开始对决" : "等待加速度传感器回传");
        initDiceGame();
    } else if (gameName === "slot") {
        setText("game-status", "点击开转，高频开奖");
        initSlotGame();
    }
}

function stopRuntimeLoops() {
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }
    clearInterval(gameLoopTimer);
    gameLoopTimer = null;
    clearTimeout(shakeStopTimeout);
    shakeStopTimeout = null;
    clearInterval(manualRollTimer);
    manualRollTimer = null;
    clearInterval(slotSpinAnimationTimer);
    slotSpinAnimationTimer = null;
    clearTimeout(slotSpinFinishTimer);
    slotSpinFinishTimer = null;
    clearTimeout(slotAutoTimer);
    slotAutoTimer = null;
    clearTimeout(slotCooldownTimer);
    slotCooldownTimer = null;
}

function exitGame() {
    stopCurrentGame();
    activeGame = null;
    selectedGame = null;
    showScreen("screen-select");
}

function stopCurrentGame() {
    stopRuntimeLoops();
    activeGame = null;
    isDiceShaking = false;
    slotIsSpinning = false;
    slotCooldownUntil = 0;
    sendGameMessage({ type: "stop_shock" });
    releaseScreenWakeLock();
    const rollButton = $("btn-roll");
    if (rollButton) {
        rollButton.disabled = false;
    }
    const slotButton = $("btn-slot-spin");
    if (slotButton) {
        slotButton.disabled = false;
    }
    setText("game-status", "已停止输出");
}

// --- 6. 统一惩罚发送与本机震动 ---

function canPunish(requiresOrientation = true) {
    if (!activeGame) return false;
    if (requiresOrientation && !orientationReady) return false;
    if (Date.now() - gameStartedAt < 1200) return false;
    return ws && ws.readyState === WebSocket.OPEN;
}

function sendPulse(strength, duration = 100) {
    const now = Date.now();
    if (now - lastPulseAt < 250) return;

    const safeStrength = clamp(Math.round(strength), 0, 200);
    if (safeStrength <= 0) return;

    lastPulseAt = now;
    sendGameMessage({
        type: "game_pulse",
        strength: safeStrength,
        duration
    });
    vibrateBriefly(40);
}

function vibrateBriefly(duration) {
    if (!navigator.vibrate) return;
    const now = Date.now();
    if (now - lastVibrateAt < 180) return;
    lastVibrateAt = now;
    navigator.vibrate(Math.round(duration));
}

// --- 7. 游戏 1：手抖挑战 ---

function prepareCanvas() {
    canvas = $("game-canvas");
    ctx = canvas.getContext("2d");

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 320;
    const height = canvas.clientHeight || 320;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { width, height };
}

function initShakeGame() {
    const { width, height } = prepareCanvas();
    ballX = width / 2;
    ballY = height / 2;
    ballVx = 0;
    ballVy = 0;
    shakeOutSince = null;

    runShakeLoop();
    gameLoopTimer = setInterval(checkShakePunish, 100);
}

function runShakeLoop() {
    if (activeGame !== "shake") return;

    const cfg = gameSettings.shake;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    const minSide = Math.min(width, height);
    const centerX = width / 2;
    const centerY = height / 2;

    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, width, height);

    const relativeBeta = clamp(phoneBeta - calibration.shakeBeta, -45, 45);
    const relativeGamma = clamp(phoneGamma - calibration.shakeGamma, -45, 45);
    const sensitivity = cfg.sensitivity / 100;

    // 倾斜量转换成弹珠速度，灵敏度越高，玩家轻微移动也会产生更明显的位移。
    ballVx += relativeGamma * 0.07 * sensitivity;
    ballVy += relativeBeta * 0.07 * sensitivity;
    ballVx *= 0.982;
    ballVy *= 0.982;
    ballX += ballVx;
    ballY += ballVy;

    if (ballX - ballRadius < 0) {
        ballX = ballRadius;
        ballVx = -ballVx * 0.5;
    } else if (ballX + ballRadius > width) {
        ballX = width - ballRadius;
        ballVx = -ballVx * 0.5;
    }

    if (ballY - ballRadius < 0) {
        ballY = ballRadius;
        ballVy = -ballVy * 0.5;
    } else if (ballY + ballRadius > height) {
        ballY = height - ballRadius;
        ballVy = -ballVy * 0.5;
    }

    ctx.strokeStyle = "#222222";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(centerX - 15, centerY);
    ctx.lineTo(centerX + 15, centerY);
    ctx.moveTo(centerX, centerY - 15);
    ctx.lineTo(centerX, centerY + 15);
    ctx.stroke();

    ctx.strokeStyle = "#ffffff";
    ctx.beginPath();
    if (cfg.mode === "radius") {
        ctx.arc(centerX, centerY, minSide * cfg.safeRadius / 100, 0, Math.PI * 2);
    } else {
        ctx.arc(centerX, centerY, minSide * cfg.gapInner / 100, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(centerX, centerY, minSide * cfg.safeRadius / 100, 0, Math.PI * 2);
    }
    ctx.stroke();

    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(ballX, ballY, ballRadius, 0, Math.PI * 2);
    ctx.fill();

    animationFrameId = requestAnimationFrame(runShakeLoop);
}

function checkShakePunish() {
    if (activeGame !== "shake" || !canPunish(true)) return;

    const cfg = gameSettings.shake;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    const minSide = Math.min(width, height);
    const centerX = width / 2;
    const centerY = height / 2;
    const dist = Math.hypot(ballX - centerX, ballY - centerY);

    let err = 0;
    if (cfg.mode === "radius") {
        const radius = minSide * cfg.safeRadius / 100;
        err = Math.max(0, dist - radius);
    } else {
        const inner = minSide * cfg.gapInner / 100;
        const outer = minSide * cfg.safeRadius / 100;
        err = dist < inner ? inner - dist : Math.max(0, dist - outer);
    }

    if (err <= 0) {
        shakeOutSince = null;
        setText("game-status", "安全区内");
        return;
    }

    if (shakeOutSince === null) {
        shakeOutSince = Date.now();
        setText("game-status", "已出界，宽容计时中");
        return;
    }

    if (Date.now() - shakeOutSince < cfg.forgiveMs) return;

    const ratio = clamp(err / (minSide * 0.22), 0, 1);
    const strength = cfg.strengthMin + (cfg.strengthMax - cfg.strengthMin) * ratio;
    setText("game-status", `出界惩罚: ${Math.round(strength)}`);
    sendPulse(strength, 120);
}

// --- 8. 游戏 2：保持角度 ---

function initAngleGame() {
    prepareCanvas();
    angleBadSince = null;
    runAngleLoop();
    gameLoopTimer = setInterval(checkAnglePunish, 100);
}

function getCurrentAngleOffset() {
    return clamp(phoneBeta - calibration.angleBeta, -90, 90);
}

function runAngleLoop() {
    if (activeGame !== "angle") return;

    const cfg = gameSettings.angle;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    const centerY = height / 2;
    const pad = 26;
    const gaugeWidth = width - pad * 2;
    const targetX = pad + ((cfg.targetOffset + 90) / 180) * gaugeWidth;
    const tolerancePx = (cfg.tolerance / 180) * gaugeWidth;
    const currentX = pad + ((getCurrentAngleOffset() + 90) / 180) * gaugeWidth;

    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = "#222222";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad, centerY);
    ctx.lineTo(width - pad, centerY);
    ctx.stroke();

    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(targetX - tolerancePx, centerY);
    ctx.lineTo(targetX + tolerancePx, centerY);
    ctx.stroke();

    ctx.strokeStyle = "#888888";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(targetX, centerY - 42);
    ctx.lineTo(targetX, centerY + 42);
    ctx.stroke();

    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(currentX, centerY - 60);
    ctx.lineTo(currentX, centerY + 60);
    ctx.stroke();

    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(currentX, centerY, 5, 0, Math.PI * 2);
    ctx.fill();

    animationFrameId = requestAnimationFrame(runAngleLoop);
}

function checkAnglePunish() {
    if (activeGame !== "angle" || !canPunish(true)) return;

    const cfg = gameSettings.angle;
    const err = Math.abs(getCurrentAngleOffset() - cfg.targetOffset) - cfg.tolerance;

    if (err <= 0) {
        angleBadSince = null;
        setText("game-status", "角度稳定");
        return;
    }

    if (angleBadSince === null) {
        angleBadSince = Date.now();
        setText("game-status", "角度偏离，等待持续判定");
        return;
    }

    if (Date.now() - angleBadSince < cfg.triggerMs) return;

    const ratio = clamp(err / cfg.rampDegrees, 0, 1);
    const strength = cfg.strengthMin + (cfg.strengthMax - cfg.strengthMin) * ratio;
    setText("game-status", `角度惩罚: ${Math.round(strength)}`);
    sendPulse(strength, 120);
}

// --- 9. 游戏 3：摇骰子对决 ---

function initDiceGame() {
    isDiceShaking = false;
    diceShakeEnergy = 0;
    setText("dice-1", "-");
    setText("dice-2", "-");
    setText("dice-3", "-");
    setText("dice-scores", "玩家总分: - | 对手总分: -");
    setText("dice-instruction", "摇晃手机 或 点击下方按钮开始摇号");
    $("dice-instruction").style.color = "#888888";
    $("btn-roll").disabled = !gameSettings.dice.manualRoll;
}

function triggerDiceShake(force) {
    const cfg = gameSettings.dice;
    const now = Date.now();

    if (!isDiceShaking) {
        isDiceShaking = true;
        diceShakeEnergy = 0;
        setText("dice-instruction", "正在摇号...");
        $("dice-instruction").style.color = "#888888";
        setText("dice-1", "?");
        setText("dice-2", "?");
        setText("dice-3", "?");
        $("btn-roll").disabled = true;
    }

    // 晃动越明显，能量越高；后续结算会把这个能量转成玩家骰子的轻微优势。
    diceShakeEnergy = clamp(diceShakeEnergy + Math.max(1, force - cfg.shakeSensitivity), 0, 120);

    if (now - lastShakeTime > 80) {
        playDiceCollisionSound();
        lastShakeTime = now;
    }

    vibrateBriefly(50);
    clearTimeout(shakeStopTimeout);
    shakeStopTimeout = setTimeout(settleDiceGame, 800);
}

function rollDicesManual() {
    const cfg = gameSettings.dice;
    if (!cfg.manualRoll || isDiceShaking) return;

    unlockAudio();
    isDiceShaking = true;
    diceShakeEnergy = 30;
    $("btn-roll").disabled = true;
    setText("dice-instruction", "正在摇号...");
    setText("dice-1", "?");
    setText("dice-2", "?");
    setText("dice-3", "?");

    let count = 0;
    manualRollTimer = setInterval(() => {
        diceShakeEnergy = clamp(diceShakeEnergy + 7, 0, 90);
        playDiceCollisionSound();
        vibrateBriefly(35);
        count++;
        if (count >= 10) {
            clearInterval(manualRollTimer);
            manualRollTimer = null;
            settleDiceGame();
        }
    }, 100);
}

function rollWeightedDie(powerRatio) {
    let value = Math.floor(Math.random() * 6) + 1;
    if (Math.random() < powerRatio * 0.45) {
        value = Math.min(6, value + 1);
    }
    if (powerRatio > 0.78 && Math.random() < 0.2) {
        value = Math.min(6, value + 1);
    }
    return value;
}

function rollOpponentDie(difficulty) {
    let value = Math.floor(Math.random() * 6) + 1;
    if (difficulty === "easy" && Math.random() < 0.28) {
        value = Math.max(1, value - 1);
    } else if (difficulty === "hard" && Math.random() < 0.28) {
        value = Math.min(6, value + 1);
    }
    return value;
}

function getTripleFace(dices) {
    return dices[0] === dices[1] && dices[1] === dices[2] ? dices[0] : 0;
}

function settleDiceGame() {
    if (!isDiceShaking) return;
    isDiceShaking = false;
    clearTimeout(shakeStopTimeout);
    shakeStopTimeout = null;

    const cfg = gameSettings.dice;
    const powerRatio = clamp(diceShakeEnergy / 90, 0, 1);
    const player = [
        rollWeightedDie(powerRatio),
        rollWeightedDie(powerRatio),
        rollWeightedDie(powerRatio)
    ];
    const opponent = [
        rollOpponentDie(cfg.opponentDifficulty),
        rollOpponentDie(cfg.opponentDifficulty),
        rollOpponentDie(cfg.opponentDifficulty)
    ];
    const pTotal = player.reduce((sum, value) => sum + value, 0);
    const oTotal = opponent.reduce((sum, value) => sum + value, 0);

    setText("dice-1", player[0]);
    setText("dice-2", player[1]);
    setText("dice-3", player[2]);
    setText("dice-scores", `玩家总分: ${pTotal} | 对手总分: ${oTotal}`);
    $("btn-roll").disabled = !cfg.manualRoll;

    const playerTriple = getTripleFace(player);
    const opponentTriple = getTripleFace(opponent);
    const leopardFace = Math.max(playerTriple, opponentTriple);
    if (leopardFace > 0) {
        const owner = playerTriple && opponentTriple ? "双方豹子" : playerTriple ? "玩家豹子" : "对手豹子";
        const punishDuration = leopardFace * cfg.leopardSecondsPerPoint * 1000;
        setText("dice-instruction", `${owner} | ${leopardFace}点豹子`);
        $("dice-instruction").style.color = "#ff3333";

        sendGameMessage({
            type: "game_shock_trigger",
            strength: Math.round(cfg.strengthMax),
            duration: Math.round(punishDuration)
        });

        if (navigator.vibrate) {
            navigator.vibrate(Math.min(1200, Math.round(punishDuration)));
        }
        return;
    }

    if (pTotal >= oTotal) {
        setText("dice-instruction", `挑战胜出 | 摇晃效率 ${Math.round(powerRatio * 100)}%`);
        $("dice-instruction").style.color = "#ffffff";
        return;
    }

    const diff = oTotal - pTotal;
    const ratio = clamp(diff / 15, 0, 1);
    const punishStrength = cfg.strengthMin + (cfg.strengthMax - cfg.strengthMin) * ratio;
    const punishDuration = (cfg.timeMin + (cfg.timeMax - cfg.timeMin) * ratio) * 1000;

    setText("dice-instruction", `挑战失败 | 差额: ${diff}`);
    $("dice-instruction").style.color = "#ff3333";

    sendGameMessage({
        type: "game_shock_trigger",
        strength: Math.round(punishStrength),
        duration: Math.round(punishDuration)
    });

    if (navigator.vibrate) {
        navigator.vibrate(Math.min(1200, Math.round(punishDuration)));
    }
}

// --- 10. 游戏 4：极速角子机 ---

function initSlotGame() {
    slotPressure = 0;
    slotMissStreak = 0;
    slotIsSpinning = false;
    slotCooldownUntil = 0;
    setText("slot-reel-1", "🍒");
    setText("slot-reel-2", "🔔");
    setText("slot-reel-3", "💎");
    setText("slot-result", "点击开转，连续空转会把压力推向满格。");
    updateSlotView();

    const button = $("btn-slot-spin");
    if (button) {
        button.disabled = false;
        button.innerText = gameSettings.slot.autoSpin ? "自动连转中" : "开转";
    }

    if (gameSettings.slot.autoSpin) {
        scheduleNextSlotSpin(600);
    }
}

function startSlotSpin() {
    if (activeGame !== "slot" || slotIsSpinning) return;

    const now = Date.now();
    if (now < slotCooldownUntil) {
        const remainSeconds = Math.ceil((slotCooldownUntil - now) / 1000);
        setText("slot-result", `冷却中，还剩约 ${remainSeconds}s。`);
        return;
    }

    const cfg = gameSettings.slot;
    slotIsSpinning = true;
    clearTimeout(slotAutoTimer);
    slotAutoTimer = null;

    const button = $("btn-slot-spin");
    if (button) {
        button.disabled = true;
        button.innerText = "开奖中...";
    }

    setText("game-status", "角子机高速转动中");
    setText("slot-result", "开奖中...");
    setSlotReelsSpinning(true);
    spinSlotReelsRandomly();

    // 转动期间只做视觉随机，不提前决定结果，避免界面闪到最终图案后又跳走。
    slotSpinAnimationTimer = setInterval(spinSlotReelsRandomly, 70);
    slotSpinFinishTimer = setTimeout(finishSlotSpin, cfg.spinMs);
}

function finishSlotSpin() {
    if (activeGame !== "slot") return;

    const cfg = gameSettings.slot;
    clearInterval(slotSpinAnimationTimer);
    slotSpinAnimationTimer = null;
    clearTimeout(slotSpinFinishTimer);
    slotSpinFinishTimer = null;

    const reels = buildSlotResult(cfg);
    setSlotReels(reels);
    setSlotReelsSpinning(false);
    slotIsSpinning = false;

    const resultType = classifySlotResult(reels);
    const triggered = applySlotResult(resultType, reels);
    if (!triggered) {
        finishSlotRound();
    }
}

function finishSlotRound() {
    if (activeGame !== "slot") return;

    const button = $("btn-slot-spin");
    if (button) {
        button.disabled = false;
        button.innerText = gameSettings.slot.autoSpin ? "自动连转中" : "开转";
    }

    if (gameSettings.slot.autoSpin) {
        scheduleNextSlotSpin(gameSettings.slot.autoIntervalMs);
    }
}

function scheduleNextSlotSpin(delayMs) {
    clearTimeout(slotAutoTimer);
    slotAutoTimer = null;

    if (activeGame !== "slot" || !gameSettings.slot.autoSpin) return;

    const cooldownDelay = Math.max(0, slotCooldownUntil - Date.now());
    const safeDelay = Math.max(delayMs, cooldownDelay);
    slotAutoTimer = setTimeout(startSlotSpin, safeDelay);
}

function spinSlotReelsRandomly() {
    setSlotReels([
        pickSlotSymbol(),
        pickSlotSymbol(),
        pickSlotSymbol()
    ]);
}

function setSlotReels(reels) {
    setText("slot-reel-1", reels[0]);
    setText("slot-reel-2", reels[1]);
    setText("slot-reel-3", reels[2]);
}

function setSlotReelsSpinning(isSpinning) {
    ["slot-reel-1", "slot-reel-2", "slot-reel-3"].forEach((id) => {
        const node = $(id);
        if (node) {
            node.classList.toggle("spinning", isSpinning);
        }
    });
}

function pickSlotSymbol(excluded = []) {
    const pool = SLOT_SYMBOLS.filter((symbol) => !excluded.includes(symbol));
    return pool[Math.floor(Math.random() * pool.length)];
}

function getSlotOdds(winRate) {
    if (winRate === "loose") {
        return { small: 0.42, jackpot: 0.14 };
    }

    if (winRate === "brutal") {
        return { small: 0.22, jackpot: 0.06 };
    }

    return { small: 0.32, jackpot: 0.09 };
}

function buildSlotResult(cfg) {
    const odds = getSlotOdds(cfg.winRate);
    const roll = Math.random();

    if (roll < odds.jackpot) {
        const symbol = Math.random() < 0.14 ? "7️⃣" : pickSlotSymbol(["7️⃣"]);
        return [symbol, symbol, symbol];
    }

    if (roll < odds.jackpot + odds.small) {
        const pairSymbol = pickSlotSymbol();
        const singleSymbol = pickSlotSymbol([pairSymbol]);
        return shuffleSlotReels([pairSymbol, pairSymbol, singleSymbol]);
    }

    const first = pickSlotSymbol();
    const second = pickSlotSymbol([first]);
    const third = pickSlotSymbol([first, second]);
    return shuffleSlotReels([first, second, third]);
}

function shuffleSlotReels(reels) {
    const result = [...reels];
    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}

function classifySlotResult(reels) {
    const counts = reels.reduce((map, symbol) => {
        map[symbol] = (map[symbol] || 0) + 1;
        return map;
    }, {});
    const maxCount = Math.max(...Object.values(counts));

    if (maxCount === 3) {
        return reels[0] === "7️⃣" ? "seven" : "jackpot";
    }

    if (maxCount === 2) {
        return "small";
    }

    return "miss";
}

function applySlotResult(resultType, reels) {
    const cfg = gameSettings.slot;
    const display = reels.join(" ");
    let message = "";

    if (resultType === "miss") {
        slotMissStreak += 1;
        const gain = cfg.missGain + Math.max(0, slotMissStreak - 1) * cfg.streakBonus;
        slotPressure = clamp(slotPressure + gain, 0, 100);
        message = `${display} | 空转，压力 +${gain}%`;
    } else if (resultType === "small") {
        slotMissStreak = Math.max(0, slotMissStreak - 1);
        slotPressure = clamp(slotPressure - cfg.smallWinDrop, 0, 100);
        message = `${display} | 小奖，压力 -${cfg.smallWinDrop}%`;
    } else if (resultType === "jackpot") {
        slotMissStreak = 0;
        slotPressure = clamp(slotPressure - cfg.jackpotDrop, 0, 100);
        message = `${display} | 大奖，压力 -${cfg.jackpotDrop}%`;
    } else if (resultType === "seven") {
        slotMissStreak = 0;
        if (cfg.sevenRule === "reset") {
            slotPressure = 0;
            message = `${display} | 三个 7，压力清空`;
        } else if (cfg.sevenRule === "shock") {
            slotPressure = 100;
            updateSlotView(`${display} | 三个 7，立即最大惩罚`);
            triggerSlotPunish("三个 7", true);
            return true;
        } else {
            slotPressure = 100;
            updateSlotView(`${display} | 三个 7，压力直接满槽`);
            triggerSlotPunish("三个 7 满槽", false);
            return true;
        }
    }

    updateSlotView(message);
    if (slotPressure >= 100) {
        triggerSlotPunish("压力满格", false);
        return true;
    }

    setText("game-status", `压力 ${Math.round(slotPressure)}%`);
    return false;
}

function triggerSlotPunish(reason, forceMax) {
    const cfg = gameSettings.slot;
    const duration = Math.round(cfg.shockSeconds * 1000);
    const ratio = forceMax ? 1 : clamp(slotPressure / 100, 0, 1);
    const strength = Math.round(cfg.strengthMin + (cfg.strengthMax - cfg.strengthMin) * ratio);
    const sent = sendGameMessage({
        type: "game_shock_trigger",
        strength,
        duration
    });

    setText("game-status", sent ? `${reason}，已触发 ${strength}` : `${reason}，但后台未连接`);
    setText("slot-result", sent ? `${reason} | ${strength} 强度，${(duration / 1000).toFixed(1)}s` : `${reason} | 未能连接后台下发`);
    vibrateBriefly(Math.min(900, duration));

    slotCooldownUntil = Date.now() + duration + 500;
    const button = $("btn-slot-spin");
    if (button) {
        button.disabled = true;
        button.innerText = "冷却中";
    }

    clearTimeout(slotCooldownTimer);
    slotCooldownTimer = setTimeout(() => {
        if (activeGame !== "slot") return;

        slotPressure = 0;
        slotMissStreak = 0;
        slotCooldownUntil = 0;
        updateSlotView("惩罚结束，压力清零。");
        finishSlotRound();
    }, duration + 500);
}

function updateSlotView(message) {
    const safePressure = clamp(slotPressure, 0, 100);
    const fill = $("slot-pressure-fill");
    if (fill) {
        fill.style.width = `${safePressure}%`;
        fill.style.backgroundColor = getSlotPressureColor(safePressure);
    }

    setText("slot-pressure-label", `${Math.round(safePressure)}%`);
    if (message !== undefined) {
        setText("slot-result", message);
    }
}

function getSlotPressureColor(value) {
    if (value >= 90) return "#ff3333";
    if (value >= 72) return "#fb923c";
    if (value >= 48) return "#facc15";
    return "#22c55e";
}

// --- 11. 初始化入口 ---

window.onload = () => {
    populateSettingsForm("shake");
    populateSettingsForm("angle");
    populateSettingsForm("dice");
    populateSettingsForm("slot");
    bindEmergencyStopEvents();
    connectWebSocket();
};
