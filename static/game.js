/* 手机小游戏端交互逻辑 game.js */

// --- 1. 全局连接与页面状态 ---

let ws = null;
let latencyTimer = null;
let reconnectTimer = null;
let suppressReconnect = false;
let sensorActionInProgress = false;

const urlParams = new URLSearchParams(window.location.search);

// Android 外壳加载网页时尽早切换到原生布局，避免原生工具栏和网页标题短暂重复闪现。
if (navigator.userAgent.includes("GameBridgeForFun/")) {
    document.documentElement.classList.add("native-host");
}

const pinnedWsPort = parseInt(urlParams.get("ws"), 10);
const hasPinnedWsPort = Number.isInteger(pinnedWsPort) && pinnedWsPort >= 1 && pinnedWsPort <= 65535;
const gameToken = urlParams.get("token") || "";
let currentWsPort = hasPinnedWsPort ? pinnedWsPort : 18081;
let triedPortsCount = 0;
const maxPortPortion = 10;
// 只有 App 和所选郊狼硬件都就绪时才允许输出；单纯扫码成功不能冒充硬件可用。
let latestDeviceConnected = false;
let latestTechState = null;

// selectedGame 是设置页当前选中的游戏；activeGame 是已经真正开始运行的游戏。
let selectedGame = null;
let activeGame = null;

// 统一保存四套游戏配置，避免一个游戏的强度和玩法参数串到另一个游戏。
const SETTINGS_STORAGE_KEY = "game_bridge_for_fun_settings_v3";
const DEFAULT_OUTPUT_SETTINGS = {
    outputMode: "a",
    bStrengthMode: "percent",
    bStrengthPercent: 50
};
const DEFAULT_SETTINGS = {
    shake: {
        ...DEFAULT_OUTPUT_SETTINGS,
        strengthMin: 20,
        strengthMax: 60,
        mode: "radius",
        safeRadius: 26,
        gapInner: 12,
        sensitivity: 55,
        forgiveMs: 600,
        restMs: 250
    },
    angle: {
        ...DEFAULT_OUTPUT_SETTINGS,
        strengthMin: 15,
        strengthMax: 70,
        targetOffset: 0,
        tolerance: 8,
        triggerMs: 800,
        rampDegrees: 28,
        restMs: 250
    },
    dice: {
        ...DEFAULT_OUTPUT_SETTINGS,
        strength: 20,
        singleSeconds: 2.0,
        gapSeconds: 0.5,
        leopardMultiplier: 3,
        maxPunishCount: 30,
        shakeSensitivity: 15,
        opponentDifficulty: "normal",
        manualRoll: true
    },
    slot: {
        ...DEFAULT_OUTPUT_SETTINGS,
        strengthMin: 20,
        strengthMax: 85,
        shockSeconds: 2.0,
        lightPunishEnabled: false,
        lightShockSeconds: 0.4,
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
    }
};

// 规则计算放在独立纯逻辑文件中，浏览器和 Node 自动化测试执行的是同一份代码。
const {
    advanceSlotState,
    buildSlotResult,
    capPunishmentCount,
    clamp,
    classifySlotResult,
    estimateDiceQueueSeconds,
    evaluateDiceRound,
    formatSettingLabel,
    hasSafeOutputLimits,
    isTimestampFresh,
    restoreSettings
} = window.GameBridgeForFunLogic;

const GAME_META = {
    shake: {
        title: "手抖挑战",
        subtitle: "调安全区大小、手机灵敏度和出界后多久开始电。",
        help: "让弹珠留在安全区里。出界太久就会开始电，离得越远越强。",
        primaryLabel: "开始强度",
        secondaryLabel: "最高强度",
        primaryValue: (cfg) => cfg.strengthMin,
        secondaryValue: (cfg) => cfg.strengthMax,
        toleranceLabel: (cfg) => cfg.mode === "gap" ? `夹缝 ${cfg.gapInner}% / ${cfg.safeRadius}%` : `半径 ${cfg.safeRadius}%`,
        triggerLabel: (cfg) => `${cfg.forgiveMs}ms 后触发 | 休息 ${cfg.restMs}ms`
    },
    angle: {
        title: "保持角度",
        subtitle: "调目标角度、允许误差和偏多久才开始电。",
        help: "按开始时的握法当基准。偏离目标角度太久才会电，短暂晃一下不会马上触发。",
        primaryLabel: "开始强度",
        secondaryLabel: "最高强度",
        primaryValue: (cfg) => cfg.strengthMin,
        secondaryValue: (cfg) => cfg.strengthMax,
        toleranceLabel: (cfg) => `目标 ${cfg.targetOffset}° ± ${cfg.tolerance}°`,
        triggerLabel: (cfg) => `${cfg.triggerMs}ms 后触发 | 休息 ${cfg.restMs}ms`
    },
    dice: {
        title: "摇骰子对决",
        subtitle: "输几点就电几下；任意一方豹子时，点数乘倍率就是次数。",
        help: "你和对手各摇 3 颗骰子。你输了几点就电几下；你或对手任意一方豹子时，按豹子点数乘倍率来算次数。",
        primaryLabel: "每下强度",
        secondaryLabel: "最多次数",
        primaryValue: (cfg) => cfg.strength,
        secondaryValue: (cfg) => `${cfg.maxPunishCount} 下`,
        toleranceLabel: (cfg) => `灵敏度 ${cfg.shakeSensitivity}`,
        triggerLabel: (cfg) => `每下 ${cfg.singleSeconds.toFixed(1)}s | 间隔 ${cfg.gapSeconds.toFixed(1)}s`
    },
    slot: {
        title: "极速角子机",
        subtitle: "调开奖速度、没中奖是否轻电、压力条涨跌和满槽电击。",
        help: "三个图案全不同时压力会上涨；中奖会降压力。压力满了就电一下，开启轻电后没中奖也会轻轻电一下。",
        primaryLabel: "轻电强度",
        secondaryLabel: "满槽强度",
        primaryValue: (cfg) => cfg.lightPunishEnabled ? cfg.strengthMin : "关闭",
        secondaryValue: (cfg) => cfg.strengthMax,
        toleranceLabel: (cfg) => `没中 +${cfg.missGain}% | 小奖 -${cfg.smallWinDrop}%`,
        triggerLabel: (cfg) => `${cfg.spinMs}ms 开奖 | 电完休息 ${cfg.restMs}ms`
    }
};

let gameSettings = loadSettings();

// --- 2. 传感器、画布与游戏运行状态 ---

let sensorsAllowed = false;
let sensorsBound = false;
let orientationReady = false;
let motionReady = false;
let lastSensorPermissionMessage = "";
let nativeSensorHostEnabled = false;
let phoneBeta = 0;   // 前后倾斜，单位为度。
let phoneGamma = 0;  // 左右倾斜，单位为度。
let shakeAcc = 0;    // 三轴加速度合成值，摇骰子时用于判断晃动强度。
let lastOrientationAt = 0;
let lastMotionAt = 0;
let sensorStopRequestedForStaleData = false;

let canvas = null;
let ctx = null;
let animationFrameId = null;
let gameLoopTimer = null;
let gameStartedAt = 0;
let nextPulseAllowedAt = 0;
let lastVibrateAt = 0;
let lastWarningVibrateAt = 0;

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
let slotLightCooldownUntil = 0;

// 连续惩罚队列用于骰子这种“输几点就电几下”的玩法，停止输出时必须能立即清掉。
let dicePunishTimer = null;
let dicePunishRemaining = 0;
let dicePunishGeneration = 0;

// 真实骰子是 3x3 点阵。这里用 1-9 表示九宫格位置，避免在多处手写点位导致显示错位。
const DICE_PIP_MAP = {
    1: [5],
    2: [1, 9],
    3: [1, 5, 9],
    4: [1, 3, 7, 9],
    5: [1, 3, 5, 7, 9],
    6: [1, 3, 4, 6, 7, 9]
};

function $(id) {
    return document.getElementById(id);
}

function readNumber(id, fallback = 0) {
    const value = parseFloat($(id).value);
    return Number.isFinite(value) ? value : fallback;
}

function setText(id, value) {
    const node = $(id);
    if (node && node.innerText !== String(value)) {
        node.innerText = String(value);
    }
}

function setConnectionClass(id, connected) {
    const node = $(id);
    if (node) {
        node.classList.toggle("connected", connected);
    }
}

function loadSettings() {
    try {
        const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return restoreSettings(DEFAULT_SETTINGS, parsed);
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
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return;
    }

    const host = window.location.hostname || "127.0.0.1";
    const wsProtocol = window.location.protocol === "https:" ? "wss" : "ws";
    const tokenQuery = gameToken ? `?token=${encodeURIComponent(gameToken)}` : "";
    const targetUrl = `${wsProtocol}://${host}:${currentWsPort}/game${tokenQuery}`;

    suppressReconnect = false;
    clearTimeout(reconnectTimer);
    const socket = new WebSocket(targetUrl);
    ws = socket;

    socket.onopen = () => {
        if (ws !== socket) return;
        console.log(`游戏端连接成功: ${targetUrl}`);
        triedPortsCount = 0;
        setText("tech-game-status", "已连接");
        setConnectionClass("tech-game-status", true);
        $("ping-badge")?.classList.add("online");
        $("ping-badge")?.classList.remove("offline");
        setText("ping-badge", "网速延迟: --ms");
        updateGlobalSafetyStatus("后台已连接，等待郊狼设备", false);

        clearInterval(latencyTimer);
        latencyTimer = setInterval(() => {
            if (ws === socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({
                    type: "ping",
                    time: Date.now()
                }));
            }
        }, 1000);
    };

    socket.onmessage = (event) => {
        if (ws !== socket) return;
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
        } else if (data.type === "test_feedback") {
            setMobileTestResult(data.message || "测试请求已处理", data.ok);
        } else if (data.type === "stop_feedback") {
            const message = data.message || "停止请求已处理";
            setMobileTestResult(message, data.ok);
            setText("game-status", message);
        } else if (data.type === "button_feedback") {
            vibrateBriefly(20);
        }
    };

    socket.onclose = (event) => {
        // 弱网下旧连接可能在新连接建立后才回调；迟到事件不得覆盖新连接或创建并行重连。
        if (ws !== socket) return;
        ws = null;
        clearInterval(latencyTimer);
        latestGameLatency = null;
        setText("ping-badge", "网速延迟: 离线");
        setText("tech-game-status", "离线");
        setConnectionClass("tech-game-status", false);
        updateGlobalSafetyStatus("后台通信已断开", false);
        $("ping-badge")?.classList.remove("online");
        $("ping-badge")?.classList.add("offline");
        updateLocalGameLatency();

        if (event.code === 1008) {
            suppressReconnect = true;
            setMobileTestResult("游戏链接无效或已过期，请回到电脑控制台重新扫码。", false);
            return;
        }

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

    socket.onerror = () => {
        // 关闭真正报错的对象，避免旧连接误关掉刚恢复的新连接。
        socket.close();
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
    if (value === null || value === undefined || value === "") return "未读取";
    const number = Number(value);
    if (!appConnected || !Number.isFinite(number)) return "未读取";
    return String(Math.round(number));
}

function getConfiguredOutputMode() {
    const cfg = gameSettings[activeGame] || gameSettings[selectedGame] || DEFAULT_OUTPUT_SETTINGS;
    return cfg.outputMode || DEFAULT_OUTPUT_SETTINGS.outputMode;
}

function isConfiguredOutputReady() {
    if (!latestTechState || !latestDeviceConnected) return false;

    const mode = getConfiguredOutputMode();
    return isOutputModeReady(mode);
}

function isOutputModeReady(mode) {
    if (!latestTechState || !latestDeviceConnected) return false;
    return hasSafeOutputLimits(mode, latestTechState.limit_a, latestTechState.limit_b);
}

function getOutputBlockReason() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return "后台未连接";
    if (!latestDeviceConnected) return latestTechState?.device_status_message || "郊狼硬件未就绪";
    if (!isConfiguredOutputReady()) return "所选通道限幅未读取或已设为 0";
    return "";
}

function updateLocalGameLatency() {
    setText("tech-game-latency", formatLatency(latestGameLatency));
}

function updateTechStatus(data) {
    latestTechState = data;
    const appConnected = Boolean(data.app_connected);
    const deviceConnected = Boolean(data.device_connected);
    latestDeviceConnected = deviceConnected;

    // 选择页的技术状态用于现场排障：端口、连接、延迟和硬件回读统一放在这里。
    setText("tech-local-ip", data.local_ip || window.location.hostname || "-");
    setText("tech-http-port", data.http_port || "-");
    setText("tech-web-ws-port", data.web_ws_port || currentWsPort || "-");
    setText("tech-app-ws-port", data.app_ws_port || "-");
    setText("tech-app-status", deviceConnected
        ? `${data.device_model || "郊狼"} 已连接`
        : appConnected
            ? "等待硬件"
            : "等待 App 扫码");
    setText("tech-game-status", data.game_connected ? "已连接" : "未连接");
    setConnectionClass("tech-app-status", deviceConnected);
    setConnectionClass("tech-game-status", Boolean(data.game_connected));
    setText("tech-app-latency", formatLatency(data.app_latency));
    const shownGameLatency = latestGameLatency !== null ? latestGameLatency : data.game_latency;
    setText("tech-game-latency", formatLatency(shownGameLatency));
    setText("tech-device-model", data.device_model || "未连接");
    setText("tech-strength-a", formatHardwareReading(data.strength_a, deviceConnected));
    setText("tech-strength-b", formatHardwareReading(data.strength_b, deviceConnected));
    setText("tech-limit-a", formatHardwareReading(data.limit_a, deviceConnected));
    setText("tech-limit-b", formatHardwareReading(data.limit_b, deviceConnected));
    setText("tech-battery", formatBatteryLevel(data.battery_level));
    refreshGlobalSafetyStatus();
}

function updateGlobalSafetyStatus(message, ready) {
    // 所有手机页面共用同一个醒目的安全状态，避免滚动后看不到当前连接结论。
    setText("global-safety-status", message);
    const bar = $("global-safety-bar");
    if (!bar) return;
    bar.classList.toggle("ready", Boolean(ready));
    bar.classList.toggle("blocked", !ready);
}

function refreshGlobalSafetyStatus() {
    // “已就绪”必须同时满足后台、硬件和当前所选通道限幅，不能只凭蓝牙在线就显示绿色。
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        updateGlobalSafetyStatus("后台通信已断开", false);
        return;
    }
    if (!latestTechState || !latestDeviceConnected) {
        updateGlobalSafetyStatus(latestTechState?.device_status_message || "等待郊狼设备", false);
        return;
    }

    const mode = getConfiguredOutputMode();
    const modeLabel = mode === "ab" ? "A+B" : mode.toUpperCase();
    if (!isOutputModeReady(mode)) {
        updateGlobalSafetyStatus(`${modeLabel} 通道限幅未读取或已设为 0`, false);
        return;
    }

    updateGlobalSafetyStatus(`${latestTechState.device_model || "郊狼设备"} · ${modeLabel} 可输出`, true);
}

function setMobileTestResult(message, ok = true) {
    const node = $("mobile-test-result");
    if (!node) return;
    node.innerText = message;
    node.style.color = ok ? "var(--text-secondary)" : "var(--danger)";
}

function runMobileSelfCheck() {
    if (!latestTechState) {
        setMobileTestResult("后台状态尚未同步，请稍等。", false);
        return;
    }

    const browserConnected = Boolean(ws && ws.readyState === WebSocket.OPEN);
    const parts = [
        browserConnected ? "浏览器已连接" : "浏览器未连接",
        latestTechState.app_connected ? "App 已绑定" : "App 未绑定",
        latestTechState.device_connected
            ? `${latestTechState.device_model || "郊狼设备"} 已连接`
            : "郊狼硬件未就绪",
        `App 延迟 ${formatLatency(latestTechState.app_latency)}`,
        `浏览器延迟 ${formatLatency(latestGameLatency ?? latestTechState.game_latency)}`,
        `A 限幅 ${formatHardwareReading(latestTechState.limit_a, latestTechState.device_connected)}`,
        `B 限幅 ${formatHardwareReading(latestTechState.limit_b, latestTechState.device_connected)}`
    ];
    const outputReady = isConfiguredOutputReady();
    if (!outputReady) {
        parts.push("所选通道尚未满足输出条件");
    }
    setMobileTestResult(
        `自检结果：${parts.join("；")}`,
        browserConnected && latestTechState.device_connected && outputReady
    );
}

function sendMobileTestShock(outputMode) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        setMobileTestResult("后台通信未连接，不能试电。", false);
        return;
    }

    if (!latestDeviceConnected) {
        setMobileTestResult(latestTechState?.device_status_message || "郊狼硬件尚未就绪，不能试电。", false);
        return;
    }
    if (!isOutputModeReady(outputMode)) {
        setMobileTestResult("所选通道限幅尚未读取或已设为 0，不能试电。", false);
        return;
    }

    sendGameMessage({
        type: "test_shock",
        outputMode,
        bStrengthMode: "same",
        bStrengthPercent: 100,
        strength: 5,
        duration: 300
    });
    setMobileTestResult("已发送测试请求，等待后台确认。");
}

function stopMobileOutput() {
    if (!sendGameMessage({ type: "stop_shock" })) {
        setMobileTestResult("后台连接已断开；服务端会按断线规则兜底停止输出。", false);
        return;
    }
    setMobileTestResult("已请求停止 A/B 输出。");
    setText("global-safety-status", "已请求停止 A/B 输出");
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
    if (nativeSensorHostEnabled || wakeLock) return;
    if (!("wakeLock" in navigator)) {
        showWakeLockWarning("当前浏览器不支持屏幕常亮；锁屏会安全停止游戏，请保持屏幕开启。");
        return;
    }

    try {
        wakeLock = await navigator.wakeLock.request("screen");
        showWakeLockWarning("");
        wakeLock.addEventListener("release", () => {
            wakeLock = null;
            if (activeGame) {
                showWakeLockWarning("屏幕常亮已失效；锁屏会安全停止游戏，请保持屏幕开启。");
            }
        });
    } catch (error) {
        console.warn("屏幕常亮请求失败，当前浏览器可能不支持 Wake Lock:", error);
        showWakeLockWarning("无法保持屏幕常亮；锁屏会安全停止游戏，请保持屏幕开启。");
    }
}

function showWakeLockWarning(message) {
    const warning = $("wake-lock-warning");
    if (!warning) return;
    setText("wake-lock-warning", message);
    warning.hidden = !message;
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
    // 即使只在做“安全试电”，页面离开前台也必须触发同一套停机和断线兜底。
    stopRuntimeLoops();
    activeGame = null;
    isDiceShaking = false;
    dicePunishRemaining = 0;
    dicePunishGeneration++;
    slotIsSpinning = false;
    slotCooldownUntil = 0;
    slotLightCooldownUntil = 0;
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
    lastSensorPermissionMessage = "";

    // Android APK 由原生 SensorManager 单向注入数据，不再受网页安全上下文限制。
    if (nativeSensorHostEnabled) {
        sensorsAllowed = true;
        return true;
    }

    const needsSecureHint = isIOSLikeDevice() && !window.isSecureContext;
    const permissionRequests = [];

    try {
        if (typeof DeviceOrientationEvent !== "undefined" &&
            typeof DeviceOrientationEvent.requestPermission === "function") {
            permissionRequests.push({
                name: "方向",
                promise: DeviceOrientationEvent.requestPermission()
            });
        }

        if (typeof DeviceMotionEvent !== "undefined" &&
            typeof DeviceMotionEvent.requestPermission === "function") {
            permissionRequests.push({
                name: "动作",
                promise: DeviceMotionEvent.requestPermission()
            });
        }

        if (permissionRequests.length > 0) {
            const results = await Promise.all(permissionRequests.map((item) => item.promise));
            const deniedItem = permissionRequests.find((item, index) => results[index] !== "granted");
            sensorsAllowed = !deniedItem;
            if (!sensorsAllowed) {
                lastSensorPermissionMessage = `${deniedItem.name}感应权限未允许，请在弹窗里选择允许`;
            }
            return sensorsAllowed;
        }
    } catch (error) {
        console.error("传感器授权失败:", error);
        lastSensorPermissionMessage = needsSecureHint
            ? "iPhone 可能要求 HTTPS 安全页面才会弹出感应器权限；请先用手动玩法，或后续改用 HTTPS/受信任证书访问"
            : "感应器权限请求失败，请确认浏览器允许动作与方向访问";
        return false;
    }

    if (needsSecureHint) {
        lastSensorPermissionMessage = "iPhone 当前通过普通 HTTP 局域网页面访问，浏览器可能不会开放动作/方向感应权限";
        return false;
    }

    if (typeof DeviceOrientationEvent === "undefined" && typeof DeviceMotionEvent === "undefined") {
        lastSensorPermissionMessage = "当前浏览器没有提供动作/方向感应器";
        return false;
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

function isIOSLikeDevice() {
    const ua = navigator.userAgent || "";
    const platform = navigator.platform || "";
    return /iPad|iPhone|iPod/.test(ua) || (platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function waitForSensorReadiness(gameName, timeoutMs = 1400) {
    const requiresOrientation = gameName === "shake" || gameName === "angle";
    const requiresMotion = gameName === "dice";
    if ((requiresOrientation && hasFreshOrientation()) || (requiresMotion && hasFreshMotion())) {
        return Promise.resolve(true);
    }

    return new Promise((resolve) => {
        const startAt = Date.now();
        const timer = setInterval(() => {
            const ready = (requiresOrientation && hasFreshOrientation()) || (requiresMotion && hasFreshMotion());
            if (ready) {
                clearInterval(timer);
                resolve(true);
                return;
            }

            if (Date.now() - startAt >= timeoutMs) {
                clearInterval(timer);
                resolve(false);
            }
        }, 50);
    });
}

function hasFreshOrientation() {
    return orientationReady && isTimestampFresh(lastOrientationAt, 1600);
}

function hasFreshMotion() {
    return motionReady && isTimestampFresh(lastMotionAt, 1600);
}

function resetRequiredSensorState(gameName) {
    // 每次开始或校准都要求拿到新的传感器回包，避免用旧状态误判“传感器可用”。
    sensorStopRequestedForStaleData = false;
    if (gameName === "shake" || gameName === "angle") {
        orientationReady = false;
        lastOrientationAt = 0;
    }

    if (gameName === "dice") {
        motionReady = false;
        lastMotionAt = 0;
        shakeAcc = 0;
    }
}

function getSensorNotReadyMessage(gameName) {
    if (lastSensorPermissionMessage) {
        return lastSensorPermissionMessage;
    }

    if (nativeSensorHostEnabled) {
        return gameName === "dice"
            ? "还没有收到 Android 摇晃数据；请保持 APK 在前台，或先用手动摇号"
            : "还没有收到 Android 倾斜数据；请保持 APK 在前台并确认手机具备动作传感器";
    }

    if (gameName === "dice") {
        return "还没有收到摇晃感应数据；可以先用手动摇号，或检查浏览器动作感应权限";
    }

    return "还没有收到倾斜感应数据；请确认 iPhone 已允许动作与方向访问，并保持网页在前台";
}

function handleOrientation(event) {
    phoneBeta = Number.isFinite(event.beta) ? event.beta : 0;
    phoneGamma = Number.isFinite(event.gamma) ? event.gamma : 0;
    orientationReady = true;
    lastOrientationAt = Date.now();
}

function handleMotion(event) {
    const acc = event.acceleration || event.accelerationIncludingGravity;
    if (!acc) return;

    const x = acc.x || 0;
    const y = acc.y || 0;
    const z = acc.z || 0;
    shakeAcc = Math.sqrt(x * x + y * y + z * z);
    motionReady = true;
    lastMotionAt = Date.now();

    const cfg = gameSettings.dice;
    if (activeGame === "dice" && shakeAcc > cfg.shakeSensitivity) {
        triggerDiceShake(shakeAcc);
    }
}

// Android 原生壳只调用这组纯数据入口，不向网页开放任何系统对象或高权限方法。
window.GameBridgeForFunNative = {
    enable() {
        nativeSensorHostEnabled = true;
        sensorsAllowed = true;
        document.documentElement.classList.add("native-host");
    },
    receiveSensorFrame(beta, gamma, x, y, z, hasOrientation, hasMotion) {
        if (!nativeSensorHostEnabled) return;
        if (hasOrientation) {
            handleOrientation({ beta: Number(beta), gamma: Number(gamma) });
        }
        if (hasMotion) {
            handleMotion({
                acceleration: {
                    x: Number(x),
                    y: Number(y),
                    z: Number(z)
                }
            });
        }
    },
    pause(reason = "android_pause") {
        emergencyStop(reason);
        closeGameSocketForEmergency();
    },
    resume() {
        suppressReconnect = false;
        if (!ws || ws.readyState === WebSocket.CLOSED) {
            connectWebSocket();
        }
    },
    stop() {
        stopCurrentGame();
    }
};

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
    document.documentElement.classList.toggle("compact-game-header", screenId !== "screen-select");
    document.querySelectorAll(".screen").forEach((node) => {
        node.classList.remove("active");
        node.hidden = true;
    });
    const screen = $(screenId);
    screen.classList.add("active");
    screen.hidden = false;
    window.scrollTo(0, 0);

    // 页面切换后把键盘和读屏焦点送到新标题，避免焦点滞留在已经隐藏的旧按钮上。
    const focusTarget = screen.querySelector("[data-screen-heading]");
    if (focusTarget) {
        window.requestAnimationFrame(() => focusTarget.focus({ preventScroll: true }));
    }
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
    resetSettingsDisclosureState(gameName);
    updateSettingsActionVisibility(gameName);
    showScreen("screen-settings");
}

function resetSettingsDisclosureState(gameName) {
    // 每次进入设置只展开当前玩法的基础分组，高级规则和通道细节保持折叠。
    document.querySelectorAll("#screen-settings details.settings-group").forEach((group) => {
        const groupGame = group.dataset.game || "common";
        const shouldOpen = groupGame === gameName && group.dataset.defaultOpen === "true";
        group.open = shouldOpen;
    });
}

function updateSettingsActionVisibility(gameName) {
    const calibrateButton = $("settings-calibrate-button");
    if (!calibrateButton) return;
    const shouldShowCalibration = gameName === "shake" || gameName === "angle";
    calibrateButton.hidden = !shouldShowCalibration;
    $("screen-settings")?.querySelector(".settings-sticky-actions")?.classList.toggle(
        "two-actions",
        !shouldShowCalibration
    );
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
        setRangeValue("shake-rest-ms", cfg.restMs);
    } else if (gameName === "angle") {
        setRangeValue("angle-strength-min", cfg.strengthMin);
        setRangeValue("angle-strength-max", cfg.strengthMax);
        setRangeValue("angle-target-offset", cfg.targetOffset);
        setRangeValue("angle-tolerance", cfg.tolerance);
        setRangeValue("angle-trigger-ms", cfg.triggerMs);
        setRangeValue("angle-ramp-degrees", cfg.rampDegrees);
        setRangeValue("angle-rest-ms", cfg.restMs);
    } else if (gameName === "dice") {
        setRangeValue("dice-strength", cfg.strength);
        setRangeValue("dice-single-seconds", cfg.singleSeconds);
        setRangeValue("dice-gap-seconds", cfg.gapSeconds);
        setRangeValue("dice-leopard-multiplier", cfg.leopardMultiplier);
        setRangeValue("dice-max-punish-count", cfg.maxPunishCount);
        setRangeValue("dice-shake-sensitivity", cfg.shakeSensitivity);
        $("dice-opponent-difficulty").value = cfg.opponentDifficulty;
        $("dice-manual-roll").checked = cfg.manualRoll;
    } else if (gameName === "slot") {
        setRangeValue("slot-strength-min", cfg.strengthMin);
        setRangeValue("slot-strength-max", cfg.strengthMax);
        setRangeValue("slot-shock-seconds", cfg.shockSeconds);
        setRangeValue("slot-light-shock-seconds", cfg.lightShockSeconds);
        setRangeValue("slot-rest-ms", cfg.restMs);
        setRangeValue("slot-spin-ms", cfg.spinMs);
        setRangeValue("slot-auto-interval-ms", cfg.autoIntervalMs);
        setRangeValue("slot-miss-gain", cfg.missGain);
        setRangeValue("slot-streak-bonus", cfg.streakBonus);
        setRangeValue("slot-small-win-drop", cfg.smallWinDrop);
        setRangeValue("slot-jackpot-drop", cfg.jackpotDrop);
        $("slot-light-punish-enabled").checked = cfg.lightPunishEnabled;
        $("slot-auto-spin").checked = cfg.autoSpin;
        $("slot-win-rate").value = cfg.winRate;
        $("slot-seven-rule").value = cfg.sevenRule;
        $("slot-pressure-after-punish").value = ["clear", "keep"].includes(cfg.pressureAfterPunish)
            ? cfg.pressureAfterPunish
            : DEFAULT_SETTINGS.slot.pressureAfterPunish;
    }

    populateOutputSettings(cfg);
}

function populateOutputSettings(cfg) {
    if (!$("common-output-mode")) return;

    $("common-output-mode").value = cfg.outputMode || DEFAULT_OUTPUT_SETTINGS.outputMode;
    $("common-b-strength-mode").value = cfg.bStrengthMode || DEFAULT_OUTPUT_SETTINGS.bStrengthMode;
    setRangeValue("common-b-strength-percent", cfg.bStrengthPercent || DEFAULT_OUTPUT_SETTINGS.bStrengthPercent);
    updateBChannelSettingsVisibility();
    setText("common-output-summary", formatOutputLabel(cfg));
}

function updateBChannelSettingsVisibility() {
    const mode = $("common-output-mode") ? $("common-output-mode").value : "a";
    const strengthMode = $("common-b-strength-mode") ? $("common-b-strength-mode").value : "percent";
    const bGroup = $("common-b-settings");
    const percentGroup = $("common-b-percent-settings");
    if (bGroup) {
        bGroup.style.display = mode === "a" ? "none" : "block";
    }
    // 只有 B 通道按比例降低时才展示比例滑块；“跟 A 一样”不需要额外百分比。
    if (percentGroup) {
        percentGroup.style.display = mode === "a" || strengthMode === "same" ? "none" : "block";
    }
}

function setRangeValue(id, value) {
    $(id).value = value;
    updateSettingValue(id, false);
}

function updateSettingValue(id, shouldSave = true) {
    const rawValue = readNumber(id, 0);
    setText(`val-${id}`, formatSettingLabel(id, rawValue));

    const control = $(id);
    if (control) {
        control.setAttribute("aria-valuetext", formatSettingLabel(id, rawValue));
    }

    if (shouldSave) {
        saveSelectedSettings(true);
    }
}

function calibrateSelectedGame() {
    if (selectedGame === "shake" || selectedGame === "angle") {
        calibrateCurrentPose(selectedGame);
    }
}

function resetSelectedSettings() {
    if (!selectedGame || !DEFAULT_SETTINGS[selectedGame]) return;

    // 当前配置全部由原始值组成，浅复制即可生成独立对象，不会反向修改默认配置。
    gameSettings[selectedGame] = { ...DEFAULT_SETTINGS[selectedGame] };
    persistSettings();
    populateSettingsForm(selectedGame);
    resetSettingsDisclosureState(selectedGame);
    refreshGlobalSafetyStatus();
    setText("settings-message", "已恢复当前玩法的默认设置");
}

function collectOutputSettings() {
    const outputMode = ["a", "b", "ab"].includes($("common-output-mode").value)
        ? $("common-output-mode").value
        : DEFAULT_OUTPUT_SETTINGS.outputMode;
    const bStrengthMode = ["same", "percent"].includes($("common-b-strength-mode").value)
        ? $("common-b-strength-mode").value
        : DEFAULT_OUTPUT_SETTINGS.bStrengthMode;

    return {
        outputMode,
        bStrengthMode,
        bStrengthPercent: clamp(readNumber("common-b-strength-percent", 50), 10, 100)
    };
}

function saveSelectedSettings(silent = false) {
    if (!selectedGame) return;

    const cfg = collectSettingsFromForm(selectedGame);
    gameSettings[selectedGame] = cfg;
    persistSettings();
    setText("common-output-summary", formatOutputLabel(cfg));
    refreshGlobalSafetyStatus();

    if (!silent) {
        setText("settings-message", "设置已保存");
    }
}

function collectSettingsFromForm(gameName) {
    if (gameName === "shake") {
        const minStrength = clamp(readNumber("shake-strength-min", 20), 0, 200);
        const maxStrength = clamp(readNumber("shake-strength-max", 60), 0, 200);
        return {
            ...collectOutputSettings(),
            strengthMin: Math.min(minStrength, maxStrength),
            strengthMax: Math.max(minStrength, maxStrength),
            mode: $("shake-mode").value,
            safeRadius: clamp(readNumber("shake-safe-radius", 26), 12, 45),
            gapInner: clamp(readNumber("shake-gap-inner", 12), 6, 28),
            sensitivity: clamp(readNumber("shake-sensitivity", 55), 20, 100),
            forgiveMs: clamp(readNumber("shake-forgive-ms", 600), 0, 2000),
            restMs: clamp(readNumber("shake-rest-ms", 250), 200, 2000)
        };
    }

    if (gameName === "angle") {
        const minStrength = clamp(readNumber("angle-strength-min", 15), 0, 200);
        const maxStrength = clamp(readNumber("angle-strength-max", 70), 0, 200);
        return {
            ...collectOutputSettings(),
            strengthMin: Math.min(minStrength, maxStrength),
            strengthMax: Math.max(minStrength, maxStrength),
            targetOffset: clamp(readNumber("angle-target-offset", 0), -45, 45),
            tolerance: clamp(readNumber("angle-tolerance", 8), 2, 30),
            triggerMs: clamp(readNumber("angle-trigger-ms", 800), 100, 2500),
            rampDegrees: clamp(readNumber("angle-ramp-degrees", 28), 5, 60),
            restMs: clamp(readNumber("angle-rest-ms", 250), 200, 2000)
        };
    }

    if (gameName === "dice") {
        return {
            ...collectOutputSettings(),
            strength: clamp(readNumber("dice-strength", 20), 0, 200),
            singleSeconds: clamp(readNumber("dice-single-seconds", 2.0), 0.5, 5.0),
            gapSeconds: clamp(readNumber("dice-gap-seconds", 0.5), 0.2, 3.0),
            leopardMultiplier: clamp(readNumber("dice-leopard-multiplier", 3), 1, 6),
            maxPunishCount: clamp(readNumber("dice-max-punish-count", 30), 1, 60),
            shakeSensitivity: clamp(readNumber("dice-shake-sensitivity", 15), 8, 35),
            opponentDifficulty: $("dice-opponent-difficulty").value,
            manualRoll: $("dice-manual-roll").checked
        };
    }

    if (gameName === "slot") {
        const minStrength = clamp(readNumber("slot-strength-min", 20), 0, 200);
        const maxStrength = clamp(readNumber("slot-strength-max", 85), 0, 200);
        return {
            ...collectOutputSettings(),
            strengthMin: Math.min(minStrength, maxStrength),
            strengthMax: Math.max(minStrength, maxStrength),
            shockSeconds: clamp(readNumber("slot-shock-seconds", 2.0), 0.5, 8.0),
            lightPunishEnabled: $("slot-light-punish-enabled").checked,
            lightShockSeconds: clamp(readNumber("slot-light-shock-seconds", 0.4), 0.1, 2.0),
            restMs: clamp(readNumber("slot-rest-ms", 800), 300, 3000),
            spinMs: clamp(readNumber("slot-spin-ms", 700), 450, 1400),
            autoSpin: $("slot-auto-spin").checked,
            autoIntervalMs: clamp(readNumber("slot-auto-interval-ms", 650), 300, 1800),
            missGain: clamp(readNumber("slot-miss-gain", 24), 8, 45),
            streakBonus: clamp(readNumber("slot-streak-bonus", 6), 0, 15),
            smallWinDrop: clamp(readNumber("slot-small-win-drop", 14), 0, 35),
            jackpotDrop: clamp(readNumber("slot-jackpot-drop", 70), 20, 100),
            winRate: $("slot-win-rate").value,
            sevenRule: $("slot-seven-rule").value,
            pressureAfterPunish: ["clear", "keep"].includes($("slot-pressure-after-punish").value)
                ? $("slot-pressure-after-punish").value
                : DEFAULT_SETTINGS.slot.pressureAfterPunish
        };
    }

    return { ...DEFAULT_SETTINGS[gameName] };
}

async function calibrateCurrentPose(gameName) {
    if (gameName !== "shake" && gameName !== "angle") return;
    if (sensorActionInProgress) {
        setText("settings-message", "感应器请求正在处理中，请稍等。");
        return;
    }

    sensorActionInProgress = true;
    try {
        resetRequiredSensorState(gameName);
        setText("settings-message", "正在请求手机倾斜感应权限...");
        const allowed = await requestSensorPermission();
        if (!allowed) {
            setText("settings-message", getSensorNotReadyMessage(gameName));
            return;
        }

        bindSensors();
        const ready = await waitForSensorReadiness(gameName);
        if (!ready) {
            setText("settings-message", getSensorNotReadyMessage(gameName));
            return;
        }

        // 等待权限期间如果用户已经离开当前设置页，不再把迟到结果写进另一款游戏。
        if (selectedGame !== gameName) return;
        if (gameName === "shake") {
            calibration.shakeBeta = phoneBeta;
            calibration.shakeGamma = phoneGamma;
        } else {
            calibration.angleBeta = phoneBeta;
        }

        setText("settings-message", "已使用当前握持姿态作为基准");
    } finally {
        sensorActionInProgress = false;
    }
}

async function startConfiguredGame() {
    if (!selectedGame) return;
    if (sensorActionInProgress) {
        setText("settings-message", "感应器请求正在处理中，请稍等。");
        return;
    }

    const gameName = selectedGame;
    sensorActionInProgress = true;
    try {
        saveSelectedSettings(true);
        const needsSensors = gameName === "shake" || gameName === "angle" || gameName === "dice";
        if (needsSensors) {
            resetRequiredSensorState(gameName);
            setText("settings-message", "正在请求手机感应器权限...");
            const allowed = await requestSensorPermission();
            if (!allowed) {
                setText("settings-message", getSensorNotReadyMessage(gameName));
                return;
            }

            bindSensors();
            const ready = await waitForSensorReadiness(gameName);
            if (!ready && (gameName === "shake" || gameName === "angle")) {
                setText("settings-message", getSensorNotReadyMessage(gameName));
                return;
            }

            if (!ready && gameName === "dice" && !gameSettings.dice.manualRoll) {
                setText("settings-message", "未收到摇晃感应数据；请先开启手动摇号，或检查 iPhone 动作感应权限");
                return;
            }

            if (!ready && gameName === "dice") {
                setText("settings-message", "未收到摇晃感应数据，进入后仍可用手动摇号");
            }
        }

        // 权限弹窗可能停留较久；用户如果已经切走，迟到结果不能擅自启动旧游戏。
        if (selectedGame !== gameName) return;
        if (gameName === "dice") unlockAudio();
        requestScreenWakeLock();

        activeGame = gameName;
        gameStartedAt = Date.now();
        nextPulseAllowedAt = 0;
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
    } finally {
        sensorActionInProgress = false;
    }
}

function setupPlayScreen(gameName) {
    const cfg = gameSettings[gameName];
    setText("game-title", GAME_META[gameName].title);
    setText("game-help", GAME_META[gameName].help);
    setText("summary-game", GAME_META[gameName].title);
    setText("summary-primary-label", GAME_META[gameName].primaryLabel);
    setText("summary-secondary-label", GAME_META[gameName].secondaryLabel);
    setText("summary-strength-min", GAME_META[gameName].primaryValue(cfg));
    setText("summary-strength-max", GAME_META[gameName].secondaryValue(cfg));
    setText("summary-tolerance", GAME_META[gameName].toleranceLabel(cfg));
    setText("summary-trigger", GAME_META[gameName].triggerLabel(cfg));
    setText("summary-output", formatOutputLabel(cfg));

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
        setText("game-status", motionReady ? "摇晃手机开始对决" : "未收到摇晃感应，可先手动摇号");
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
    clearTimeout(dicePunishTimer);
    dicePunishTimer = null;
    dicePunishRemaining = 0;
    dicePunishGeneration++;
    clearInterval(slotSpinAnimationTimer);
    slotSpinAnimationTimer = null;
    clearTimeout(slotSpinFinishTimer);
    slotSpinFinishTimer = null;
    clearTimeout(slotAutoTimer);
    slotAutoTimer = null;
    clearTimeout(slotCooldownTimer);
    slotCooldownTimer = null;
    nextPulseAllowedAt = 0;
    sensorStopRequestedForStaleData = false;
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
    dicePunishRemaining = 0;
    dicePunishGeneration++;
    slotIsSpinning = false;
    slotCooldownUntil = 0;
    slotLightCooldownUntil = 0;
    nextPulseAllowedAt = 0;
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
    setText("global-safety-status", "已请求停止 A/B 输出");
}

// --- 6. 统一惩罚发送与本机震动 ---

function canPunish(requiresOrientation = true) {
    if (!activeGame) return false;
    if (requiresOrientation && !hasFreshOrientation()) {
        // 页面仍在线但原生传感器或浏览器权限流已经停更时，WebSocket 心跳还会继续。
        // 因此这里必须单独发一次停止命令，并清掉旧的出界计时，不能让最后一帧坏姿态无限续罚。
        shakeOutSince = null;
        angleBadSince = null;
        if (!sensorStopRequestedForStaleData) {
            sensorStopRequestedForStaleData = true;
            sendGameMessage({ type: "stop_shock" });
            setText("game-status", "感应器数据已中断，输出已停止；恢复后重新计时");
        }
        return false;
    }
    sensorStopRequestedForStaleData = false;
    // 郊狼硬件未就绪时直接拦截，避免按钮进入“正在输出”的假状态。
    if (!latestDeviceConnected) return false;
    if (!isConfiguredOutputReady()) return false;
    if (Date.now() - gameStartedAt < 1200) return false;
    return ws && ws.readyState === WebSocket.OPEN;
}

function sendPulse(strength, duration = 100, restMs = 250) {
    const now = Date.now();
    const safeDuration = clamp(Math.round(duration), 100, 500);
    const safeRestMs = clamp(Math.round(restMs), 200, 3000);
    if (now < nextPulseAllowedAt) return;

    const safeStrength = clamp(Math.round(strength), 0, 200);
    if (safeStrength <= 0) return;

    nextPulseAllowedAt = now + safeDuration + safeRestMs;
    sendGameMessage({
        type: "game_pulse",
        strength: safeStrength,
        duration: safeDuration,
        ...getOutputPayload()
    });
    vibrateBriefly(40);
}

function getOutputPayload() {
    const cfg = gameSettings[activeGame] || DEFAULT_OUTPUT_SETTINGS;
    return {
        outputMode: cfg.outputMode || DEFAULT_OUTPUT_SETTINGS.outputMode,
        bStrengthMode: cfg.bStrengthMode || DEFAULT_OUTPUT_SETTINGS.bStrengthMode,
        bStrengthPercent: cfg.bStrengthPercent || DEFAULT_OUTPUT_SETTINGS.bStrengthPercent
    };
}

function sendConfiguredShock(strength, duration) {
    const safeStrength = clamp(Math.round(strength), 0, 200);
    if (safeStrength <= 0) return false;
    // 发送前再次确认硬件就绪状态，防止 App 已扫码但蓝牙设备离线时空发。
    if (!latestDeviceConnected || !isConfiguredOutputReady()) return false;

    return sendGameMessage({
        type: "game_shock_trigger",
        strength: safeStrength,
        duration: Math.round(duration),
        ...getOutputPayload()
    });
}

function formatOutputLabel(cfg) {
    const mode = cfg.outputMode || "a";
    const bText = cfg.bStrengthMode === "same" ? "B 同强度" : `B ${cfg.bStrengthPercent}%`;

    if (mode === "b") {
        return `只用 B | ${bText}`;
    }

    if (mode === "ab") {
        return `A+B | ${bText}`;
    }

    return "只用 A";
}

function vibrateBriefly(duration) {
    if (!navigator.vibrate) return;
    const now = Date.now();
    if (now - lastVibrateAt < 180) return;
    lastVibrateAt = now;
    navigator.vibrate(Math.round(duration));
}

// 浏览器支持震动时，按“短-停-长”这类节奏反馈输赢；不支持时自动静默，不影响游戏规则。
function vibratePattern(pattern, minGap = 180) {
    if (!navigator.vibrate) return;
    const now = Date.now();
    if (now - lastVibrateAt < minGap) return;
    lastVibrateAt = now;
    navigator.vibrate(pattern);
}

// 危险提醒要和普通开奖震动分开限频，否则偏离安全区时会把手机震个不停。
function vibrateWarning(duration = 18, minGap = 650) {
    if (!navigator.vibrate) return;
    const now = Date.now();
    if (now - lastWarningVibrateAt < minGap) return;
    lastWarningVibrateAt = now;
    navigator.vibrate(duration);
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

function getShakeZoneState(cfg, width, height) {
    const minSide = Math.min(width, height);
    const centerX = width / 2;
    const centerY = height / 2;
    const dist = Math.hypot(ballX - centerX, ballY - centerY);
    const outer = minSide * cfg.safeRadius / 100;
    const inner = cfg.mode === "gap" ? minSide * cfg.gapInner / 100 : 0;
    let err = 0;

    // 手抖挑战有两种玩法：普通圆形安全区、夹缝安全区。统一算出 err，后面画面和惩罚都复用它。
    if (cfg.mode === "radius") {
        err = Math.max(0, dist - outer);
    } else {
        err = dist < inner ? inner - dist : Math.max(0, dist - outer);
    }

    return {
        centerX,
        centerY,
        inner,
        outer,
        err,
        dangerRatio: clamp(err / (minSide * 0.22), 0, 1)
    };
}

function runShakeLoop() {
    if (activeGame !== "shake") return;

    const cfg = gameSettings.shake;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;

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

    const zone = getShakeZoneState(cfg, width, height);
    const dangerAlpha = 0.06 + zone.dangerRatio * 0.18;

    if (zone.err > 0) {
        ctx.fillStyle = `rgba(255, 51, 51, ${dangerAlpha})`;
        ctx.fillRect(0, 0, width, height);
    }

    ctx.strokeStyle = "#151515";
    ctx.lineWidth = 1;
    for (let x = 0; x <= width; x += 36) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
    }
    for (let y = 0; y <= height; y += 36) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
    }

    ctx.strokeStyle = zone.err > 0 ? "#ff3333" : "#333333";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(zone.centerX - 18, zone.centerY);
    ctx.lineTo(zone.centerX + 18, zone.centerY);
    ctx.moveTo(zone.centerX, zone.centerY - 18);
    ctx.lineTo(zone.centerX, zone.centerY + 18);
    ctx.stroke();

    ctx.lineWidth = 2;
    ctx.shadowBlur = zone.err > 0 ? 18 : 10;
    ctx.shadowColor = zone.err > 0 ? "rgba(255, 51, 51, 0.65)" : "rgba(34, 197, 94, 0.35)";
    ctx.strokeStyle = zone.err > 0 ? "#ff3333" : "#ffffff";
    ctx.beginPath();
    if (cfg.mode === "radius") {
        ctx.arc(zone.centerX, zone.centerY, zone.outer, 0, Math.PI * 2);
    } else {
        ctx.arc(zone.centerX, zone.centerY, zone.inner, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(zone.centerX, zone.centerY, zone.outer, 0, Math.PI * 2);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.fillStyle = zone.err > 0 ? "#ff3333" : "#ffffff";
    ctx.shadowBlur = zone.err > 0 ? 18 : 10;
    ctx.shadowColor = zone.err > 0 ? "rgba(255, 51, 51, 0.7)" : "rgba(255, 255, 255, 0.35)";
    ctx.beginPath();
    ctx.arc(ballX, ballY, ballRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    animationFrameId = requestAnimationFrame(runShakeLoop);
}

function checkShakePunish() {
    if (activeGame !== "shake" || !canPunish(true)) return;

    const cfg = gameSettings.shake;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    const zone = getShakeZoneState(cfg, width, height);

    if (zone.err <= 0) {
        shakeOutSince = null;
        setText("game-status", "安全区内");
        return;
    }

    if (shakeOutSince === null) {
        shakeOutSince = Date.now();
        setText("game-status", "已出界，宽容计时中");
        return;
    }

    const elapsed = Date.now() - shakeOutSince;
    if (elapsed < cfg.forgiveMs) {
        const remain = Math.ceil((cfg.forgiveMs - elapsed) / 100) / 10;
        setText("game-status", `已出界，约 ${remain.toFixed(1)}s 后触发`);
        vibrateWarning();
        return;
    }

    const ratio = zone.dangerRatio;
    const strength = cfg.strengthMin + (cfg.strengthMax - cfg.strengthMin) * ratio;
    setText("game-status", `出界惩罚: ${Math.round(strength)}，电完休息 ${cfg.restMs}ms`);
    sendPulse(strength, 120, cfg.restMs);
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

function getAngleState(cfg) {
    const offset = getCurrentAngleOffset();
    const rawErr = Math.abs(offset - cfg.targetOffset) - cfg.tolerance;
    return {
        offset,
        err: Math.max(0, rawErr),
        dangerRatio: clamp(Math.max(0, rawErr) / cfg.rampDegrees, 0, 1)
    };
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
    const angleState = getAngleState(cfg);
    const currentX = pad + ((angleState.offset + 90) / 180) * gaugeWidth;
    const dangerColor = angleState.err > 0 ? "#ff3333" : "#ffffff";

    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, width, height);

    if (angleState.err > 0) {
        ctx.fillStyle = `rgba(255, 51, 51, ${0.05 + angleState.dangerRatio * 0.18})`;
        ctx.fillRect(0, 0, width, height);
    }

    ctx.strokeStyle = "#151515";
    ctx.lineWidth = 1;
    for (let x = pad; x <= width - pad; x += Math.max(24, gaugeWidth / 8)) {
        ctx.beginPath();
        ctx.moveTo(x, centerY - 74);
        ctx.lineTo(x, centerY + 74);
        ctx.stroke();
    }

    ctx.strokeStyle = "#333333";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pad, centerY);
    ctx.lineTo(width - pad, centerY);
    ctx.stroke();

    ctx.strokeStyle = angleState.err > 0 ? "#fb923c" : "#22c55e";
    ctx.lineWidth = 8;
    ctx.lineCap = "round";
    ctx.shadowBlur = angleState.err > 0 ? 12 : 8;
    ctx.shadowColor = angleState.err > 0 ? "rgba(251, 146, 60, 0.42)" : "rgba(34, 197, 94, 0.36)";
    ctx.beginPath();
    ctx.moveTo(targetX - tolerancePx, centerY);
    ctx.lineTo(targetX + tolerancePx, centerY);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.lineCap = "butt";

    ctx.strokeStyle = "#888888";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(targetX, centerY - 42);
    ctx.lineTo(targetX, centerY + 42);
    ctx.stroke();

    ctx.strokeStyle = dangerColor;
    ctx.lineWidth = 3;
    ctx.shadowBlur = angleState.err > 0 ? 18 : 8;
    ctx.shadowColor = angleState.err > 0 ? "rgba(255, 51, 51, 0.68)" : "rgba(255, 255, 255, 0.36)";
    ctx.beginPath();
    ctx.moveTo(currentX, centerY - 60);
    ctx.lineTo(currentX, centerY + 60);
    ctx.stroke();

    ctx.fillStyle = dangerColor;
    ctx.beginPath();
    ctx.arc(currentX, centerY, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.fillStyle = "#777777";
    ctx.font = "12px monospace";
    ctx.textAlign = "center";
    ctx.fillText(`目标 ${cfg.targetOffset}°`, targetX, centerY + 92);
    ctx.fillStyle = angleState.err > 0 ? "#ff3333" : "#ffffff";
    ctx.fillText(`当前 ${Math.round(angleState.offset)}°`, currentX, centerY - 82);

    animationFrameId = requestAnimationFrame(runAngleLoop);
}

function checkAnglePunish() {
    if (activeGame !== "angle" || !canPunish(true)) return;

    const cfg = gameSettings.angle;
    const angleState = getAngleState(cfg);

    if (angleState.err <= 0) {
        angleBadSince = null;
        setText("game-status", "角度稳定");
        return;
    }

    if (angleBadSince === null) {
        angleBadSince = Date.now();
        setText("game-status", "角度偏离，等待持续判定");
        return;
    }

    const elapsed = Date.now() - angleBadSince;
    if (elapsed < cfg.triggerMs) {
        const remain = Math.ceil((cfg.triggerMs - elapsed) / 100) / 10;
        setText("game-status", `角度偏离，约 ${remain.toFixed(1)}s 后触发`);
        vibrateWarning();
        return;
    }

    const ratio = angleState.dangerRatio;
    const strength = cfg.strengthMin + (cfg.strengthMax - cfg.strengthMin) * ratio;
    setText("game-status", `角度惩罚: ${Math.round(strength)}，电完休息 ${cfg.restMs}ms`);
    sendPulse(strength, 120, cfg.restMs);
}

// --- 9. 游戏 3：摇骰子对决 ---

function setDiceFace(id, value, isRolling = false) {
    const node = $(id);
    if (!node) return;

    const numericValue = Number(value);
    const pips = DICE_PIP_MAP[numericValue];
    node.classList.toggle("pending", isRolling || value === "?");
    node.classList.toggle("empty", value === "-");
    node.replaceChildren();

    // 正常点数用九宫格画出真实骰子点；等待和空状态仍保留文字，玩家一眼能看出是否已开奖。
    if (!pips) {
        node.textContent = value;
        return;
    }

    const grid = document.createElement("div");
    grid.className = "dice-face-grid";
    for (let index = 1; index <= 9; index++) {
        const pip = document.createElement("span");
        pip.className = pips.includes(index) ? "dice-pip active" : "dice-pip";
        grid.appendChild(pip);
    }

    const label = document.createElement("span");
    label.className = "sr-only";
    label.textContent = `${numericValue} 点`;
    node.appendChild(grid);
    node.appendChild(label);
}

function setDiceFaces(prefix, values, isRolling = false) {
    values.forEach((value, index) => {
        const id = prefix ? `${prefix}-${index + 1}` : `dice-${index + 1}`;
        setDiceFace(id, value, isRolling);
    });
}

function setDiceRoundFaces(playerValues, opponentValues, isRolling = false) {
    setDiceFaces("", playerValues, isRolling);
    setDiceFaces("opponent-dice", opponentValues, isRolling);
}

function initDiceGame() {
    isDiceShaking = false;
    diceShakeEnergy = 0;
    dicePunishRemaining = 0;
    dicePunishGeneration++;
    setDiceRoundFaces(["-", "-", "-"], ["-", "-", "-"]);
    setText("dice-scores", "玩家总分: - | 对手总分: -");
    setText("dice-instruction", "摇晃手机，或点击按钮开一局");
    $("dice-instruction").style.color = "#888888";
    $("btn-roll").disabled = !gameSettings.dice.manualRoll;
}

function triggerDiceShake(force) {
    const cfg = gameSettings.dice;
    const now = Date.now();
    // 按钮在惩罚期间会禁用，传感器也必须遵守同一边界，避免再次摇晃覆盖正在结算的队列。
    if (activeGame !== "dice" || dicePunishRemaining > 0 || dicePunishTimer !== null) return;

    if (!isDiceShaking) {
        isDiceShaking = true;
        diceShakeEnergy = 0;
        setText("dice-instruction", "正在摇号...");
        $("dice-instruction").style.color = "#888888";
        setDiceRoundFaces(["?", "?", "?"], ["?", "?", "?"], true);
        $("btn-roll").disabled = true;
    }

    // 晃动只负责触发开局；骰子本身保持简单随机，避免玩家还要理解隐藏加成。
    diceShakeEnergy = clamp(diceShakeEnergy + Math.max(1, force - cfg.shakeSensitivity), 0, 120);

    if (now - lastShakeTime > 80) {
        playDiceCollisionSound();
        setDiceRoundFaces(
            [rollPlayerDie(), rollPlayerDie(), rollPlayerDie()],
            [rollOpponentDie(cfg.opponentDifficulty), rollOpponentDie(cfg.opponentDifficulty), rollOpponentDie(cfg.opponentDifficulty)],
            true
        );
        lastShakeTime = now;
    }

    vibrateBriefly(50);
    clearTimeout(shakeStopTimeout);
    shakeStopTimeout = setTimeout(settleDiceGame, 800);
}

function rollDicesManual() {
    const cfg = gameSettings.dice;
    if (!cfg.manualRoll || isDiceShaking || dicePunishRemaining > 0 || dicePunishTimer !== null) return;

    unlockAudio();
    isDiceShaking = true;
    diceShakeEnergy = 30;
    $("btn-roll").disabled = true;
    setText("dice-instruction", "正在摇号...");
    setDiceRoundFaces(["?", "?", "?"], ["?", "?", "?"], true);

    let count = 0;
    manualRollTimer = setInterval(() => {
        diceShakeEnergy = clamp(diceShakeEnergy + 7, 0, 90);
        playDiceCollisionSound();
        vibrateBriefly(35);
        setDiceRoundFaces(
            [rollPlayerDie(), rollPlayerDie(), rollPlayerDie()],
            [rollOpponentDie(cfg.opponentDifficulty), rollOpponentDie(cfg.opponentDifficulty), rollOpponentDie(cfg.opponentDifficulty)],
            true
        );
        count++;
        if (count >= 10) {
            clearInterval(manualRollTimer);
            manualRollTimer = null;
            settleDiceGame();
        }
    }, 100);
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
    const player = [
        rollPlayerDie(),
        rollPlayerDie(),
        rollPlayerDie()
    ];
    const opponent = [
        rollOpponentDie(cfg.opponentDifficulty),
        rollOpponentDie(cfg.opponentDifficulty),
        rollOpponentDie(cfg.opponentDifficulty)
    ];
    const outcome = evaluateDiceRound(player, opponent, cfg.leopardMultiplier);

    setDiceRoundFaces(player, opponent);
    setText("dice-scores", `玩家总分: ${outcome.playerTotal} | 对手总分: ${outcome.opponentTotal}`);
    $("btn-roll").disabled = !cfg.manualRoll;

    if (outcome.kind === "leopard") {
        vibratePattern([80, 35, 120], 0);
        startDicePunishQueue(outcome.punishmentCount, outcome.reason);
        return;
    }

    if (outcome.kind === "win") {
        setText("dice-instruction", outcome.reason);
        $("dice-instruction").style.color = "#ffffff";
        vibratePattern([28, 35, 28], 0);
        return;
    }

    vibratePattern([45, 30, 90], 0);
    startDicePunishQueue(outcome.punishmentCount, outcome.reason);
}

function rollPlayerDie() {
    return Math.floor(Math.random() * 6) + 1;
}

function startDicePunishQueue(rawCount, reason) {
    const cfg = gameSettings.dice;
    const cappedCount = capPunishmentCount(rawCount, cfg.maxPunishCount);

    if (cappedCount <= 0) {
        setText("dice-instruction", "没有惩罚");
        $("dice-instruction").style.color = "#ffffff";
        return;
    }

    const outputBlockReason = getOutputBlockReason();
    if (outputBlockReason) {
        dicePunishRemaining = 0;
        setText("dice-instruction", `${reason} | ${outputBlockReason}，未输出`);
        $("dice-instruction").style.color = "#ff3333";
        $("btn-roll").disabled = !gameSettings.dice.manualRoll;
        return;
    }

    clearTimeout(dicePunishTimer);
    dicePunishTimer = null;
    dicePunishGeneration++;
    dicePunishRemaining = cappedCount;
    const cappedText = rawCount > cappedCount ? `，已按上限截到 ${cappedCount} 下` : "";
    const estimateSeconds = estimateDiceQueueSeconds(cappedCount, cfg);
    setText("dice-instruction", `${reason} | 准备电 ${cappedCount} 下，约 ${estimateSeconds.toFixed(1)}s${cappedText}`);
    $("dice-instruction").style.color = "#ff3333";
    $("btn-roll").disabled = true;
    runNextDicePunish(dicePunishGeneration);
}

function runNextDicePunish(generation) {
    if (activeGame !== "dice" || generation !== dicePunishGeneration || dicePunishRemaining <= 0) {
        return;
    }

    const cfg = gameSettings.dice;
    const totalDuration = Math.round(cfg.singleSeconds * 1000);
    const gapDuration = Math.round(cfg.gapSeconds * 1000);
    const currentIndex = dicePunishRemaining;
    const sent = sendConfiguredShock(cfg.strength, totalDuration);
    setText(
        "dice-instruction",
        sent
            ? `正在电 | 剩余 ${currentIndex} 下，每下 ${cfg.singleSeconds.toFixed(1)}s，间隔 ${cfg.gapSeconds.toFixed(1)}s`
            : `${getOutputBlockReason() || "输出忙"} | 本局队列已停止，未输出`
    );
    $("dice-instruction").style.color = "#ff3333";

    if (!sent) {
        // 网络断开或输出忙时立即终止本局，不能继续倒计数并伪装成硬件已经执行。
        dicePunishRemaining = 0;
        dicePunishTimer = null;
        $("btn-roll").disabled = !gameSettings.dice.manualRoll;
        return;
    }

    if (navigator.vibrate) {
        navigator.vibrate(Math.min(900, totalDuration));
    }

    dicePunishRemaining -= 1;
    const nextDelay = dicePunishRemaining <= 0 ? totalDuration : totalDuration + gapDuration;
    dicePunishTimer = setTimeout(() => {
        dicePunishTimer = null;
        if (activeGame !== "dice" || generation !== dicePunishGeneration) {
            return;
        }

        if (dicePunishRemaining <= 0) {
            setText("dice-instruction", "本局惩罚结束");
            $("dice-instruction").style.color = "#888888";
            $("btn-roll").disabled = !gameSettings.dice.manualRoll;
            return;
        }

        runNextDicePunish(generation);
    }, nextDelay);
}

// --- 10. 游戏 4：极速角子机 ---

function initSlotGame() {
    slotPressure = 0;
    slotMissStreak = 0;
    slotIsSpinning = false;
    slotCooldownUntil = 0;
    slotLightCooldownUntil = 0;
    setText("slot-reel-1", "🍒");
    setText("slot-reel-2", "🔔");
    setText("slot-reel-3", "💎");
    setSlotResultState("");
    setText("slot-result", "点击开转。没中奖会涨压力，压力满了就电。");
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
        setText("slot-result", `电完休息中，还剩约 ${remainSeconds}s。`);
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
    setSlotResultState("");
    setSlotReelsSpinning(true);
    spinSlotReelsRandomly();
    vibrateBriefly(18);

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

    const reels = buildSlotResult(cfg, SLOT_SYMBOLS);
    setSlotReels(reels);
    setSlotReelsSpinning(false);
    slotIsSpinning = false;

    const resultType = classifySlotResult(reels);
    setSlotResultState(resultType);
    vibrateSlotOutcome(resultType);
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

function setSlotResultState(resultType) {
    const classMap = {
        miss: "result-miss",
        small: "result-small",
        jackpot: "result-jackpot",
        seven: "result-seven"
    };
    const nextClass = classMap[resultType] || "";

    ["slot-reel-1", "slot-reel-2", "slot-reel-3"].forEach((id) => {
        const node = $(id);
        if (!node) return;

        Object.values(classMap).forEach((className) => node.classList.remove(className));
        if (nextClass) {
            node.classList.add(nextClass);
        }
    });
}

function vibrateSlotOutcome(resultType) {
    if (resultType === "miss") {
        vibratePattern([24], 80);
    } else if (resultType === "small") {
        vibratePattern([22, 35, 22], 80);
    } else if (resultType === "jackpot") {
        vibratePattern([40, 35, 80], 80);
    } else if (resultType === "seven") {
        vibratePattern([80, 40, 130], 80);
    }
}

function pickSlotSymbol(excluded = []) {
    const pool = SLOT_SYMBOLS.filter((symbol) => !excluded.includes(symbol));
    return pool[Math.floor(Math.random() * pool.length)];
}

function applySlotResult(resultType, reels) {
    const cfg = gameSettings.slot;
    const display = reels.join(" ");
    const nextState = advanceSlotState(
        { pressure: slotPressure, missStreak: slotMissStreak },
        cfg,
        resultType
    );
    slotPressure = nextState.pressure;
    slotMissStreak = nextState.missStreak;
    updateSlotView(`${display} | ${nextState.message}`);

    if (nextState.triggerPunishment) {
        triggerSlotPunish(nextState.punishmentReason, nextState.forceMaximum);
        return true;
    }

    const lightText = resultType === "miss" && cfg.lightPunishEnabled ? triggerSlotLightPunish() : "";
    if (resultType === "miss" && slotPressure >= 72) {
        vibrateWarning(28, 360);
    }
    setText("game-status", lightText ? `${lightText} | 压力 ${Math.round(slotPressure)}%` : `压力 ${Math.round(slotPressure)}%`);
    return false;
}

function triggerSlotLightPunish() {
    const cfg = gameSettings.slot;
    const now = Date.now();
    if (now < slotLightCooldownUntil) return "轻电冷却中";

    const duration = Math.round(cfg.lightShockSeconds * 1000);
    const sent = sendConfiguredShock(cfg.strengthMin, duration);
    if (sent) {
        const nextAllowedAt = now + duration + cfg.restMs;
        slotLightCooldownUntil = nextAllowedAt;
        slotCooldownUntil = Math.max(slotCooldownUntil, nextAllowedAt);
        vibratePattern([30], 80);
    }

    return sent
        ? `没中奖轻电 ${cfg.strengthMin}，休息 ${cfg.restMs}ms`
        : `${getOutputBlockReason() || "输出忙"}，未输出`;
}

function triggerSlotPunish(reason, forceMax) {
    const cfg = gameSettings.slot;
    const duration = Math.round(cfg.shockSeconds * 1000);
    const ratio = forceMax ? 1 : clamp(slotPressure / 100, 0, 1);
    const strength = Math.round(cfg.strengthMin + (cfg.strengthMax - cfg.strengthMin) * ratio);
    const sent = sendConfiguredShock(strength, duration);
    const shouldClearPressure = cfg.pressureAfterPunish !== "keep";
    const outputBlockReason = getOutputBlockReason() || "输出忙";

    setText("game-status", sent ? `${reason}，已触发 ${strength}` : `${reason}，${outputBlockReason}`);
    setText("slot-result", sent ? `${reason} | ${strength} 强度，${(duration / 1000).toFixed(1)}s` : `${reason} | ${outputBlockReason}，未输出`);
    vibratePattern([120, 45, 180, 45, Math.min(240, duration)], 0);

    if (!sent) {
        // 只有真实完成惩罚后才执行“清空压力”；断线或输出忙不能让本局无代价结算。
        settleSlotPressureAfterPunish(false, `${reason} | ${outputBlockReason}，未实际输出，压力保留 100%`);
        finishSlotRound();
        return;
    }

    slotCooldownUntil = Date.now() + duration + cfg.restMs;
    const button = $("btn-slot-spin");
    if (button) {
        button.disabled = true;
        button.innerText = "休息中";
    }

    clearTimeout(slotCooldownTimer);
    slotCooldownTimer = setTimeout(() => {
        if (activeGame !== "slot") return;

        slotCooldownUntil = 0;
        setSlotResultState("");
        settleSlotPressureAfterPunish(
            shouldClearPressure,
            shouldClearPressure ? "惩罚结束，压力清零。" : "惩罚结束，压力保留 100%。"
        );
        finishSlotRound();
    }, duration + cfg.restMs);
}

function settleSlotPressureAfterPunish(shouldClearPressure, message) {
    // 满槽惩罚结算后只处理角子机自己的压力条，不改变硬件输出规则。
    slotPressure = shouldClearPressure ? 0 : 100;
    slotMissStreak = 0;
    updateSlotView(message);
}

function updateSlotView(message) {
    const safePressure = clamp(slotPressure, 0, 100);
    const fill = $("slot-pressure-fill");
    if (fill) {
        fill.style.width = `${safePressure}%`;
        fill.style.backgroundColor = getSlotPressureColor(safePressure);
        fill.classList.toggle("critical", safePressure >= 90);

        const track = fill.parentElement;
        if (track) {
            track.classList.toggle("hot", safePressure >= 72 && safePressure < 90);
            track.classList.toggle("critical", safePressure >= 90);
        }
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

function enhanceControlAccessibility() {
    // 旧页面的大量滑块只在视觉上有标题；这里统一补齐读屏名称，避免逐项复制绑定代码。
    document.querySelectorAll("input[type='range'], select").forEach((control) => {
        if (control.hasAttribute("aria-label")) return;

        const container = control.closest(".slider-container") || control.parentElement;
        const visualLabel = container?.querySelector(".slider-label");
        const firstLabelPart = visualLabel?.querySelector("span")?.textContent?.trim();
        const labelText = firstLabelPart || visualLabel?.textContent?.trim();
        if (labelText) {
            control.setAttribute("aria-label", labelText);
        }
    });

    // 拖动期间只更新当前数值，松手后再统一显示经过边界归一化的结果，避免每一帧重建整张设置表单。
    document.querySelectorAll("input[type='range']").forEach((control) => {
        control.addEventListener("change", () => {
            if (selectedGame) populateSettingsForm(selectedGame);
        });
    });
}

window.onload = () => {
    populateSettingsForm("shake");
    populateSettingsForm("angle");
    populateSettingsForm("dice");
    populateSettingsForm("slot");
    enhanceControlAccessibility();
    bindEmergencyStopEvents();
    updateGlobalSafetyStatus("正在连接电脑服务", false);
    connectWebSocket();
};
