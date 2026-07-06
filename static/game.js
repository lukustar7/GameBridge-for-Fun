/* 手机小游戏端交互逻辑 game.js */

// --- 1. 全局连接与页面状态 ---

let ws = null;
let latencyTimer = null;
let reconnectTimer = null;

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

// 统一保存三套游戏配置，避免一个游戏的强度和玩法参数串到另一个游戏。
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
        manualRoll: true
    }
};

const GAME_META = {
    shake: {
        title: "手抖挑战",
        subtitle: "设置弹珠安全区、倾斜灵敏度和出界后的宽容时间。",
        toleranceLabel: (cfg) => cfg.mode === "gap" ? `夹缝 ${cfg.gapInner}% / ${cfg.safeRadius}%` : `半径 ${cfg.safeRadius}%`,
        triggerLabel: (cfg) => `${cfg.forgiveMs}ms 后触发`
    },
    angle: {
        title: "保持角度",
        subtitle: "以校准姿态为基准，设置目标角度、允许误差和持续偏离时间。",
        toleranceLabel: (cfg) => `目标 ${cfg.targetOffset}° ± ${cfg.tolerance}°`,
        triggerLabel: (cfg) => `${cfg.triggerMs}ms 后触发`
    },
    dice: {
        title: "摇骰子对决",
        subtitle: "设置摇晃灵敏度、对手难度和失败后的惩罚区间。",
        toleranceLabel: (cfg) => `灵敏度 ${cfg.shakeSensitivity}`,
        triggerLabel: (cfg) => `${cfg.timeMin.toFixed(1)}s - ${cfg.timeMax.toFixed(1)}s`
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
            dice: { ...DEFAULT_SETTINGS.dice, ...(parsed.dice || {}) }
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

    clearTimeout(reconnectTimer);
    ws = new WebSocket(targetUrl);

    ws.onopen = () => {
        console.log(`游戏端连接成功: ${targetUrl}`);
        triedPortsCount = 0;
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
            setText("ping-badge", `网速延迟: ${rtt}ms`);

            sendGameMessage({
                type: "latency_report",
                rtt
            });
        } else if (data.type === "button_feedback") {
            vibrateBriefly(20);
        }
    };

    ws.onclose = () => {
        clearInterval(latencyTimer);
        setText("ping-badge", "网速延迟: 离线");

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
        $("dice-opponent-difficulty").value = cfg.opponentDifficulty;
        $("dice-manual-roll").checked = cfg.manualRoll;
    }
}

function setRangeValue(id, value) {
    $(id).value = value;
    updateSettingValue(id, false);
}

function updateSettingValue(id, shouldSave = true) {
    const rawValue = readNumber(id, 0);
    let label = String(rawValue);

    if (id.endsWith("safe-radius") || id.endsWith("gap-inner")) {
        label = `${rawValue}%`;
    } else if (id.endsWith("forgive-ms") || id.endsWith("trigger-ms")) {
        label = `${rawValue}ms`;
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
        opponentDifficulty: $("dice-opponent-difficulty").value,
        manualRoll: $("dice-manual-roll").checked
    };
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
    const allowed = await requestSensorPermission();
    if (!allowed) {
        setText("settings-message", "需要允许运动与方向感应权限");
        return;
    }

    bindSensors();
    if (selectedGame === "dice") {
        unlockAudio();
    }

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
    setText("summary-game", GAME_META[gameName].title);
    setText("summary-strength-min", cfg.strengthMin);
    setText("summary-strength-max", cfg.strengthMax);
    setText("summary-tolerance", GAME_META[gameName].toleranceLabel(cfg));
    setText("summary-trigger", GAME_META[gameName].triggerLabel(cfg));

    $("game-viewport").style.display = gameName === "dice" ? "none" : "block";
    $("dice-viewport").style.display = gameName === "dice" ? "block" : "none";

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
    sendGameMessage({ type: "stop_shock" });
    const rollButton = $("btn-roll");
    if (rollButton) {
        rollButton.disabled = false;
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

// --- 10. 初始化入口 ---

window.onload = () => {
    populateSettingsForm("shake");
    populateSettingsForm("angle");
    populateSettingsForm("dice");
    connectWebSocket();
};
