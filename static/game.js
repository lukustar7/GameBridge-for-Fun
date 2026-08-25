/* 手机小游戏端交互逻辑 game.js */

// --- 1. 全局连接与页面状态 ---

let ws = null;
let latencyTimer = null;
let reconnectTimer = null;
let suppressReconnect = false;
let sensorActionInProgress = false;
let mobileTestStatusTimer = null;

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
let activeSelectionTab = "play";

// 统一保存四套游戏配置，避免一个游戏的强度和玩法参数串到另一个游戏。
const SETTINGS_STORAGE_KEY = "game_bridge_for_fun_settings_v3";
const WAVEFORM_STORAGE_KEY = "game_bridge_for_fun_waveform_v1";
const GLOBAL_OUTPUT_STORAGE_KEY = "game_bridge_for_fun_global_output_v1";
const DEFAULT_WAVEFORM = "game_default";
// 手机试电不再暴露额外强度控件；15 来自郊狼 2.0 真机可感知结果，1 秒由后台硬上限兜底。
const MOBILE_TEST_STRENGTH = 15;
const MOBILE_TEST_DURATION_MS = 1000;
const DICE_OUTPUT_BUDGET_SECONDS = 300;
const SENSOR_CONTROL_FRAME_REST_MS = 250;
const WAVEFORM_LABELS = Object.freeze({
    game_default: "游戏默认",
    random: "随机（按时长）",
    extrusion: "挤压",
    bubble: "气泡",
    rhythm: "律动",
    air_waves: "电波",
    dance: "舞步",
    climb: "攀登",
    shade: "树荫",
    pulse: "脉冲",
    breathing: "呼吸",
    tide: "潮汐",
    pulsating: "连击",
    quick_rub: "快速按捏",
    gradual_rub: "按捏渐强",
    heartbeat: "心跳节奏",
    compress: "压缩",
    rhythmic: "节奏步伐"
});
const DEFAULT_OUTPUT_SETTINGS = {
    outputMode: "a"
};
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
    dice: {
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
    },
    lightning: {
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
    }
};

// 规则计算放在独立纯逻辑文件中，浏览器和 Node 自动化测试执行的是同一份代码。
const {
    advanceSlotState,
    advanceLightningState,
    buildSlotResult,
    calculateDiceExecutionPlan,
    clamp,
    classifySlotResult,
    estimateDiceQueueSeconds,
    evaluateDiceRound,
    formatSettingLabel,
    getEffectiveBaseStrengthLimit,
    hasSafeOutputLimits,
    isTimestampFresh,
    calculateLightningStrength,
    createLightningState,
    applyStandaloneShockDurationFloor,
    migrateLegacyOutputSettings,
    normalizeLightningSettings,
    clampGameStrengthSettings,
    resolveStoredGlobalOutputSettings,
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
        triggerLabel: (cfg) => `${cfg.forgiveMs}ms 后触发 | 回到安全区立即停止`
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
        subtitle: "调开奖速度、没中奖是否轻电、压力条涨跌和满槽惩罚。",
        help: "三个图案全不同时压力会上涨；中奖会降压力。压力满了就电一下，开启轻电后没中奖也会轻轻电一下。",
        primaryLabel: "轻电强度",
        secondaryLabel: "满槽惩罚强度",
        primaryValue: (cfg) => cfg.lightPunishEnabled ? cfg.strengthMin : "关闭",
        secondaryValue: (cfg) => cfg.strengthMax,
        toleranceLabel: (cfg) => `没中 +${cfg.missGain}% | 小奖 -${cfg.smallWinDrop}%`,
        triggerLabel: (cfg) => `${cfg.spinMs}ms 开奖 | 电完休息 ${cfg.restMs}ms`
    },
    lightning: {
        title: "雷电极速",
        subtitle: "设置速度对应强度、行驶输出节奏和可选堵车规则；60 km/h 为固定硬停止线。",
        help: "速度达到启动值并稳定 2 秒后开始。速度越快请求强度越高；低速、超速、定位异常和切后台都会安全停止或切换规则。",
        primaryLabel: "起始强度",
        secondaryLabel: "最高强度",
        primaryValue: (cfg) => cfg.startStrength,
        secondaryValue: (cfg) => cfg.maxStrength,
        toleranceLabel: (cfg) => `${cfg.startSpeed} km/h 启动 | ${cfg.fullSpeed} km/h 满强度`,
        triggerLabel: (cfg) => `${cfg.continuousSeconds}s 输出 | ${cfg.drivingRestSeconds}s 休息`
    }
};

// 参数页最多显示三个任务分类。每个数字对应当前游戏内 settings-group 的顺序，
// 这样既不复制任何控件，也不会让全局波形和通道重新混回单个游戏里。
const SETTINGS_CATEGORY_LAYOUT = Object.freeze({
    shake: [
        { label: "基础", groupIndexes: [0] },
        { label: "节奏", groupIndexes: [1] }
    ],
    dice: [
        { label: "基础", groupIndexes: [0] },
        { label: "规则", groupIndexes: [1] }
    ],
    slot: [
        { label: "基础", groupIndexes: [0, 1] },
        { label: "节奏", groupIndexes: [2] },
        { label: "规则", groupIndexes: [3, 4] }
    ],
    lightning: [
        { label: "基础", groupIndexes: [0] },
        { label: "行驶", groupIndexes: [1] },
        { label: "堵车", groupIndexes: [2] }
    ]
});
const SELECTION_TAB_META = Object.freeze({
    play: {
        title: "选择玩法",
        description: "先选玩法；连接、权限和输出方式统一放在“全局设置”。"
    },
    setup: {
        title: "全局设置",
        description: "在这里统一完成连接自检、权限检查、波形和输出通道设置。"
    },
    info: {
        title: "说明与排障",
        description: "查看连接数据和安全规则；这些信息不会挤占日常选择玩法的页面。"
    }
});

let gameSettings = loadSettings();
const loadedGlobalOutput = loadGlobalOutputSettings();
let globalOutputSettings = loadedGlobalOutput.settings;
let globalOutputRequiresConfirmation = loadedGlobalOutput.requiresConfirmation;
let selectedWaveform = loadWaveformSetting();

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

// 所有玩法共用同一份能力状态。页面只保存“是否可用”和传感器质量，不持久化坐标。
const capabilityState = {
    motion: { status: "unchecked", detail: "尚未检查动作与方向感应器" },
    location: { status: "unchecked", detail: "尚未检查 GPS/GNSS 速度" },
    wake: { status: "unchecked", detail: "尚未检查屏幕常亮支持" },
    vibration: { status: "unchecked", detail: "尚未检查本机震动支持" }
};
let capabilityCheckInProgress = false;
let locationWatchId = null;
let locationTrackingActive = false;
let nativeLocationHostEnabled = false;
let nativeHasGpsHardware = false;
let nativeHasOrientationSensor = false;
let nativeHasMotionSensor = false;
let nativeLocationPermission = "unknown";
let nativeLocationServiceEnabled = false;
let latestLocationSample = null;
let lastLocationErrorMessage = "";
let locationValidSampleCount = 0;
let locationValidationStartedAt = 0;

// 雷电极速只消费脱敏后的速度、精度和时间；经纬度不会进入游戏状态、网络消息或本地存储。
let lightningState = null;
let lightningLoopTimer = null;
let lightningNextOutputAt = 0;
let lightningJamBatchCount = 0;
let lightningJamBatchRestUntil = 0;
let lightningLastMode = "";
let lightningResumeFromJam = false;
let lightningRequestSequence = 0;
let lightningOutputPending = false;
let lightningCurrentOutputUntil = 0;
let lightningSafetyAcceptedForAttempt = false;
let lightningSessionId = "";
let lightningLastSafetySampleAt = 0;
const pendingLightningRequests = new Map();

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
    shakeGamma: 0
};

// 手抖挑战状态。
let ballX = 0;
let ballY = 0;
let ballVx = 0;
let ballVy = 0;
let shakeOutSince = null;
const ballRadius = 8;

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
// “🎰”图标自身常带 777，容易和三枚“7️⃣”特殊事件混淆，因此改用含义单一的四叶草。
const SLOT_SYMBOLS = ["🍒", "🍋", "🍇", "🔔", "⭐", "💎", "7️⃣", "🍀"];
let slotPressure = 0;
let slotMissStreak = 0;
let slotIsSpinning = false;
let slotSpinAnimationTimer = null;
let slotSpinFinishTimer = null;
let slotAutoTimer = null;
let slotCooldownTimer = null;
let slotCooldownUntil = 0;
let slotLightCooldownUntil = 0;
let slotOutputUntil = 0;
let slotRestUntil = 0;

// 连续惩罚队列用于骰子这种“输几点就电几下”的玩法，停止输出时必须能立即清掉。
let dicePunishTimer = null;
let dicePunishRemaining = 0;
let dicePunishGeneration = 0;
let diceRoundId = "";
let dicePunishSequence = 0;
let standaloneRequestSequence = 0;
const pendingStandaloneRequests = new Map();

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

function stepSetting(id, delta) {
    const input = document.getElementById(id);
    if (!input) return;
    const step = Number(input.step) || 1;
    const min = Number(input.min) || 0;
    const max = Number(input.max) || 100;
    let cur = Number(input.value);
    let next = cur + delta;
    next = Math.max(min, Math.min(max, next));
    if (step < 1) {
        next = Math.round(next * 10) / 10;
    } else {
        next = Math.round(next);
    }
    input.value = next;
    updateSettingValue(id);
}
window.stepSetting = stepSetting;

function setText(id, value) {
    const node = $(id);
    if (node && node.innerText !== String(value)) {
        node.innerText = String(value);
    }
}

function createRuntimeId(prefix) {
    // 运行局号只用于把同一局的多条消息关联起来，不包含设备、位置或用户信息。
    const randomPart = typeof globalThis.crypto?.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}-${randomPart}`;
}

function setGamePhase(phase, detail = "") {
    // 主状态栏始终先说清楚当前处于哪一阶段。游戏细节可以继续变化，但不能让
    // 长间隔看起来像页面卡死，也不能把仍在输出的时段误写成“休息中”。
    const labels = {
        ready: "等待操作",
        checking: "等待判定",
        drawing: "开奖中",
        output: "输出中",
        rest: "休息中",
        interval: "间隔中",
        paused: "已暂停",
        blocked: "无法输出",
        stopped: "已停止"
    };
    const safePhase = Object.prototype.hasOwnProperty.call(labels, phase) ? phase : "ready";
    const text = detail ? `${labels[safePhase]} · ${detail}` : labels[safePhase];
    setText("game-status", text);
    const node = $("game-status");
    if (node) node.dataset.phase = safePhase;
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
        const restored = applyStandaloneShockDurationFloor(restoreSettings(DEFAULT_SETTINGS, parsed));
        restored.lightning = normalizeLightningSettings(restored.lightning, DEFAULT_SETTINGS.lightning);
        return restored;
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

function loadGlobalOutputSettings() {
    try {
        const stored = localStorage.getItem(GLOBAL_OUTPUT_STORAGE_KEY);
        if (stored) {
            return resolveStoredGlobalOutputSettings(DEFAULT_OUTPUT_SETTINGS, JSON.parse(stored));
        }

        // 旧版把通道设置分别存进各个游戏。首次升级时只在所有旧设置完全一致时自动继承，
        // 任何冲突都会进入待确认状态，防止静默切到错误通道。
        const legacyRaw = localStorage.getItem(SETTINGS_STORAGE_KEY);
        const legacySettings = legacyRaw ? JSON.parse(legacyRaw) : {};
        const migrated = migrateLegacyOutputSettings(
            DEFAULT_OUTPUT_SETTINGS,
            legacySettings,
            ["shake", "angle", "dice", "slot"]
        );
        localStorage.setItem(GLOBAL_OUTPUT_STORAGE_KEY, JSON.stringify({
            ...migrated.settings,
            confirmed: !migrated.requiresConfirmation
        }));
        return migrated;
    } catch (error) {
        console.warn("读取全局输出设置失败，正式输出已暂停:", error);
        return {
            settings: { ...DEFAULT_OUTPUT_SETTINGS },
            requiresConfirmation: true
        };
    }
}

function persistGlobalOutputSettings() {
    try {
        localStorage.setItem(GLOBAL_OUTPUT_STORAGE_KEY, JSON.stringify({
            ...globalOutputSettings,
            confirmed: !globalOutputRequiresConfirmation
        }));
    } catch (error) {
        console.warn("保存全局输出设置失败:", error);
    }
}

function normalizeWaveformKey(value) {
    // 本地缓存和页面表单都不可信，只允许后端同样认识的固定选项。
    return typeof value === "string" && Object.prototype.hasOwnProperty.call(WAVEFORM_LABELS, value)
        ? value
        : DEFAULT_WAVEFORM;
}

function loadWaveformSetting() {
    try {
        return normalizeWaveformKey(localStorage.getItem(WAVEFORM_STORAGE_KEY));
    } catch (error) {
        console.warn("读取本地波形设置失败，已使用游戏默认:", error);
        return DEFAULT_WAVEFORM;
    }
}

function persistWaveformSetting() {
    try {
        localStorage.setItem(WAVEFORM_STORAGE_KEY, selectedWaveform);
    } catch (error) {
        console.warn("保存本地波形设置失败:", error);
    }
}

function saveWaveformSetting() {
    const selector = $("global-waveform");
    selectedWaveform = normalizeWaveformKey(selector?.value);
    if (selector) selector.value = selectedWaveform;
    persistWaveformSetting();
    refreshGlobalOutputPresentation();
    setText("global-output-message", `输出感觉已设为“${formatWaveformLabel(selectedWaveform)}”，所有玩法共用。`);
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
        setText("ping-badge", "--ms");
        updateGlobalSafetyStatus("未连接", false);

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
            setText("ping-badge", `${rtt}ms`);
            updateLocalGameLatency();

            sendGameMessage({
                type: "latency_report",
                rtt
            });
        } else if (data.type === "state_update") {
            updateTechStatus(data);
        } else if (data.type === "test_feedback") {
            clearTimeout(mobileTestStatusTimer);
            mobileTestStatusTimer = null;
            if (data.ok) {
                setMobileTestResult(`试电中：${data.message || "后台已确认"}`, true);
                mobileTestStatusTimer = setTimeout(() => {
                    mobileTestStatusTimer = null;
                    setMobileTestResult("试电结束，可以继续检查或开始游戏。", true);
                }, MOBILE_TEST_DURATION_MS);
            } else {
                setMobileTestResult(data.message || "测试请求未执行", false);
            }
        } else if (data.type === "stop_feedback") {
            const message = data.message || "停止请求已处理";
            setMobileTestResult(message, data.ok);
            if (activeGame) setGamePhase(data.ok ? "stopped" : "blocked", message);
            if (activeGame === "lightning" && !data.ok) {
                lightningNextOutputAt = Number.POSITIVE_INFINITY;
                setText("lightning-next-action", "停止未确认，请在设备 App 中手动停止");
            }
        } else if (data.type === "lightning_feedback") {
            const requestId = Number(data.requestId);
            const requestSessionId = pendingLightningRequests.get(requestId);
            if (requestId !== 0) pendingLightningRequests.delete(requestId);
            const belongsToCurrentSession = requestId === 0 || requestSessionId === lightningSessionId;
            if (!data.ok && activeGame === "lightning" && belongsToCurrentSession) {
                lightningOutputPending = false;
                lightningCurrentOutputUntil = 0;
                lightningNextOutputAt = Math.max(lightningNextOutputAt, Date.now() + 1000);
                setGamePhase("blocked", data.message || "雷电极速输出被安全规则拒绝");
            }
        } else if (data.type === "game_shock_feedback" && !data.ok) {
            const message = data.message || "后台拒绝了本次输出";
            const requestId = Number(data.requestId);
            const pendingRequest = pendingStandaloneRequests.get(requestId);
            pendingStandaloneRequests.delete(requestId);
            if (!pendingRequest || pendingRequest.game !== activeGame) return;
            if (activeGame === "dice") {
                clearTimeout(dicePunishTimer);
                dicePunishTimer = null;
                dicePunishRemaining = 0;
                dicePunishGeneration++;
                setGamePhase("blocked", message);
                setText("dice-instruction", `${message}；本局队列已停止。`);
                const rollButton = $("btn-roll");
                if (rollButton) rollButton.disabled = !gameSettings.dice.manualRoll;
            } else if (activeGame === "slot") {
                clearTimeout(slotCooldownTimer);
                slotCooldownTimer = null;
                slotCooldownUntil = 0;
                slotOutputUntil = 0;
                slotRestUntil = 0;
                setGamePhase("blocked", message);
                setText("slot-result", `${message}，本轮未实际输出。`);
                finishSlotRound();
            }
        } else if (data.type === "game_shock_feedback") {
            // 成功回执只用于释放请求关联；界面已经按本地节奏显示输出阶段。
            pendingStandaloneRequests.delete(Number(data.requestId));
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
        setText("ping-badge", "离线");
        setText("tech-game-status", "离线");
        setConnectionClass("tech-game-status", false);
        updateGlobalSafetyStatus("未连接", false);
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
    return globalOutputSettings.outputMode || DEFAULT_OUTPUT_SETTINGS.outputMode;
}

function isConfiguredOutputReady() {
    if (globalOutputRequiresConfirmation) return false;
    if (!latestTechState || !latestDeviceConnected) return false;

    const mode = getConfiguredOutputMode();
    return isOutputModeReady(mode);
}

function isOutputModeReady(mode) {
    if (!latestTechState || !latestDeviceConnected) return false;
    return hasSafeOutputLimits(mode, latestTechState.limit_a, latestTechState.limit_b);
}

function getCurrentEffectiveStrengthLimit() {
    if (!latestTechState || !latestDeviceConnected) return 0;
    return getEffectiveBaseStrengthLimit(
        getConfiguredOutputMode(),
        latestTechState.limit_a,
        latestTechState.limit_b
    );
}

function refreshGameStrengthLimit() {
    const effectiveLimit = getCurrentEffectiveStrengthLimit();
    setText(
        "global-effective-strength-limit",
        effectiveLimit > 0 ? `最高 ${effectiveLimit}` : "等待有效限幅"
    );

    const inputIds = [
        "shake-strength-min", "shake-strength-max", "dice-strength",
        "slot-strength-min", "slot-strength-max", "lightning-start-strength",
        "lightning-max-strength", "lightning-jam-strength"
    ];
    inputIds.forEach((id) => {
        const input = $(id);
        if (!input) return;
        if (!input.dataset.ruleMax) input.dataset.ruleMax = input.max;
        const ruleMaximum = Number(input.dataset.ruleMax) || 200;
        input.max = String(effectiveLimit > 0 ? Math.min(ruleMaximum, effectiveLimit) : ruleMaximum);
    });

    if (effectiveLimit <= 0) return;
    const limited = clampGameStrengthSettings(gameSettings, effectiveLimit);
    if (JSON.stringify(limited) !== JSON.stringify(gameSettings)) {
        gameSettings = limited;
        persistSettings();
        if (selectedGame) populateSettingsForm(selectedGame);
        setText("settings-message", `部分强度已按设备 App 当前上限 ${effectiveLimit} 自动降低。`);
    }
}

function getOutputBlockReason() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return "后台未连接";
    if (!latestDeviceConnected) return latestTechState?.device_status_message || "郊狼硬件未就绪";
    if (globalOutputRequiresConfirmation) return "全局输出设置尚未确认";
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
    setText("tech-app-version", data.app_version || "-");
    setText("tech-local-ip", data.local_ip || window.location.hostname || "-");
    setText("tech-http-port", data.http_port || "-");
    setText("tech-web-ws-port", data.web_ws_port || currentWsPort || "-");
    setText("tech-app-ws-port", data.app_ws_port || "-");

    const modelName = data.device_model || "";
    let shortDeviceStatus = "未连接";
    if (deviceConnected) {
        if (modelName.includes("3.0") || modelName.includes("DG-LAB 3")) shortDeviceStatus = "硬件 3.0";
        else if (modelName.includes("2.0") || modelName.includes("DG-LAB 2")) shortDeviceStatus = "硬件 2.0";
        else shortDeviceStatus = modelName || "已连接";
    } else if (appConnected) {
        shortDeviceStatus = "等待硬件";
    }

    setText("tech-app-status", shortDeviceStatus);
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
    refreshGameStrengthLimit();
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
        updateGlobalSafetyStatus("未连接", false);
        return;
    }
    if (!latestTechState || !latestDeviceConnected) {
        updateGlobalSafetyStatus(latestTechState?.app_connected ? "等待硬件" : "未连接", false);
        return;
    }

    if (globalOutputRequiresConfirmation) {
        updateGlobalSafetyStatus("请确认通道", false);
        return;
    }

    const mode = getConfiguredOutputMode();
    const modeLabel = mode === "ab" ? "A+B" : mode.toUpperCase();
    if (!isOutputModeReady(mode)) {
        updateGlobalSafetyStatus(`通道 ${modeLabel} 限幅为 0`, false);
        return;
    }

    const modelName = latestTechState.device_model || "";
    let shortName = "硬件";
    if (modelName.includes("3.0") || modelName.includes("DG-LAB 3")) shortName = "硬件 3.0";
    else if (modelName.includes("2.0") || modelName.includes("DG-LAB 2")) shortName = "硬件 2.0";
    else if (modelName) shortName = modelName;

    updateGlobalSafetyStatus(`${shortName} · 通道 ${modeLabel}`, true);
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
        parts.push(globalOutputRequiresConfirmation
            ? "全局输出通道尚未确认"
            : "所选通道尚未满足输出条件");
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
        waveform: DEFAULT_WAVEFORM,
        strength: MOBILE_TEST_STRENGTH,
        duration: MOBILE_TEST_DURATION_MS
    });
    setMobileTestResult("试电中；后台确认后会在 1 秒内自动结束。");
}

function stopMobileOutput() {
    const serviceAvailable = ws && ws.readyState === WebSocket.OPEN;
    clearTimeout(mobileTestStatusTimer);
    mobileTestStatusTimer = null;

    // 顶部按钮是人工急停，不只是“清掉当前一帧”：必须同时杀掉骰子队列、角子机延时和感应循环。
    // exitGame 会先调用 stopCurrentGame 发出唯一一次 A/B 停止，再退回玩法列表，防止旧定时器稍后重新输出。
    exitGame();

    if (!serviceAvailable) {
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
    if (activeGame === "lightning") {
        stopLocationTracking();
        endLightningSession(reason);
    }
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
    setGamePhase("stopped", "已紧急停止");
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

    const needsSecureHint = !window.isSecureContext;
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
            ? "手机浏览器需要 HTTPS 安全页面才能使用动作与方向感应器；请安装本项目证书后扫描 HTTPS 二维码"
            : "感应器权限请求失败，请确认浏览器允许动作与方向访问";
        return false;
    }

    if (needsSecureHint) {
        lastSensorPermissionMessage = "当前通过普通 HTTP 局域网页面访问；手机浏览器不会开放动作与方向感应权限，请改用 HTTPS";
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

function waitForSensorReadiness(gameName, timeoutMs = 1400) {
    const requiresOrientation = gameName === "shake";
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
    if (gameName === "shake") {
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

    return "还没有收到倾斜感应数据；请确认手机浏览器已允许动作与方向访问，并保持网页在前台";
}

function updateCapabilityPresentation() {
    const names = ["motion", "location", "wake", "vibration"];
    let readyCount = 0;
    names.forEach((name) => {
        const state = capabilityState[name];
        const statusNode = $(`capability-${name}-state`);
        const detailNode = $(`capability-${name}-detail`);
        if (statusNode) {
            statusNode.classList.toggle("ready", state.status === "ready");
            statusNode.classList.toggle("blocked", state.status === "blocked");
            statusNode.innerText = {
                ready: "已就绪",
                partial: "部分可用",
                checking: "检查中",
                blocked: "不可用",
                unchecked: "待检查"
            }[state.status] || "待检查";
        }
        if (detailNode) detailNode.innerText = state.detail;
        if (state.status === "ready") readyCount++;
    });
    setText("capability-summary", `${readyCount} 项就绪 · ${names.length - readyCount} 项待处理`);
}

function setCapabilityState(name, status, detail) {
    if (!capabilityState[name]) return;
    capabilityState[name] = { status, detail };
    updateCapabilityPresentation();
}

function showCapabilityCenter(message = "") {
    showSelectScreen("setup");
    const center = $("capability-center");
    if (!center) return;
    center.open = true;
    if (message) setText("capability-message", message);
    window.requestAnimationFrame(() => center.querySelector("summary")?.focus({ preventScroll: true }));
}

function showCapabilityHelp() {
    const nativeHint = nativeSensorHostEnabled
        ? "Android APK：在系统设置的本应用权限中允许定位，并打开系统定位服务；返回后点击“检查或重试”。"
        : "Safari：打开当前网站的页面菜单与网站设置，把位置、动作与方向改为询问或允许；也可到系统设置的 Safari 与定位服务中修改。Android 浏览器：在网站设置与系统应用权限中允许定位和动作传感器。";
    setText("capability-message", `${nativeHint} 权限被系统永久拒绝时，网页或 APK 不能强行再次弹窗。`);
}

function waitUntil(predicate, timeoutMs) {
    return new Promise((resolve) => {
        const startedAt = Date.now();
        const timer = setInterval(() => {
            if (predicate()) {
                clearInterval(timer);
                resolve(true);
            } else if (Date.now() - startedAt >= timeoutMs) {
                clearInterval(timer);
                resolve(false);
            }
        }, 80);
    });
}

async function checkMotionCapability() {
    setCapabilityState("motion", "checking", "正在请求并验证动作与方向数据...");
    lastSensorPermissionMessage = "";
    const allowed = await requestSensorPermission();
    if (!allowed) {
        setCapabilityState("motion", "blocked", getSensorNotReadyMessage("shake"));
        return false;
    }

    bindSensors();
    const received = await waitUntil(() => hasFreshOrientation() || hasFreshMotion(), 1800);
    const orientationAvailable = hasFreshOrientation() || (nativeSensorHostEnabled && nativeHasOrientationSensor);
    const motionAvailable = hasFreshMotion() || (nativeSensorHostEnabled && nativeHasMotionSensor);
    if (!received && !orientationAvailable && !motionAvailable) {
        setCapabilityState("motion", "blocked", "已允许权限，但没有收到动作或方向数据；请保持页面在前台并重试。");
        return false;
    }

    if (orientationAvailable && motionAvailable) {
        setCapabilityState("motion", "ready", "方向与摇晃数据均可用，支持手抖、角度和感应骰子。");
        return true;
    }

    const supported = orientationAvailable ? "倾斜方向" : "摇晃动作";
    setCapabilityState("motion", "partial", `只检测到${supported}数据；依赖另一类数据的玩法会被阻止或要求使用手动操作。`);
    return true;
}

function inspectPassiveCapabilities() {
    if (nativeSensorHostEnabled || "wakeLock" in navigator) {
        setCapabilityState("wake", "ready", nativeSensorHostEnabled
            ? "Android APK 连接游戏后由原生外壳保持屏幕开启。"
            : "当前浏览器支持屏幕常亮；开始游戏后会请求启用。");
    } else {
        setCapabilityState("wake", "blocked", "当前浏览器不支持屏幕常亮；锁屏仍会触发安全停止，请手动保持屏幕开启。");
    }

    if (typeof navigator.vibrate === "function") {
        setCapabilityState("vibration", "ready", "当前设备支持网页震动反馈；这不会改变外接设备强度。");
    } else {
        setCapabilityState("vibration", "blocked", "当前浏览器不提供本机震动反馈；游戏和外接设备输出仍可正常运行。");
    }
}

function recordLocationSample(speedKmh, accuracyMeters, speedAccuracyKmh, timestamp, source) {
    const speed = Number(speedKmh);
    const accuracy = Number(accuracyMeters);
    const speedAccuracy = speedAccuracyKmh === null || speedAccuracyKmh === undefined
        ? null
        : Number(speedAccuracyKmh);
    const sampleTime = Number(timestamp);
    const valid = Number.isFinite(speed) && speed >= 0 && speed <= 250 &&
        Number.isFinite(accuracy) && accuracy > 0 && accuracy <= 50 &&
        Number.isFinite(sampleTime) && Math.abs(Date.now() - sampleTime) <= 3000 &&
        (speedAccuracy === null || (Number.isFinite(speedAccuracy) && speedAccuracy <= 12));

    latestLocationSample = {
        valid,
        speedKmh: valid ? speed : null,
        accuracyMeters: Number.isFinite(accuracy) ? accuracy : null,
        speedAccuracyKmh: speedAccuracy,
        timestamp: sampleTime,
        source
    };

    if (valid) {
        if (locationValidationStartedAt === 0) locationValidationStartedAt = Date.now();
        locationValidSampleCount++;
        if (locationValidSampleCount >= 2 && Date.now() - locationValidationStartedAt >= 700) {
            setCapabilityState(
                "location",
                "ready",
                `已验证可靠速度数据；当前精度约 ${Math.round(accuracy)} 米。经纬度不会保存或发送到电脑。`
            );
        } else {
            setCapabilityState("location", "checking", "已收到速度，正在确认数据持续性...");
        }
    } else {
        locationValidSampleCount = 0;
        locationValidationStartedAt = 0;
        const detail = !Number.isFinite(speed)
            ? "定位已返回，但没有可用速度；无法确认设备具备可靠 GPS/GNSS 测速能力。"
            : `定位精度不足（约 ${Number.isFinite(accuracy) ? Math.round(accuracy) : "未知"} 米），暂不允许启动。`;
        setCapabilityState("location", "checking", detail);
    }
}

function handleWebLocation(position) {
    const coords = position?.coords;
    if (!coords) return;
    const timestamp = Number(position.timestamp) || Date.now();
    const speedKmh = Number.isFinite(Number(coords.speed)) && Number(coords.speed) >= 0
        ? Number(coords.speed) * 3.6
        : null;

    // 网页没有标准接口能直接查询“是否装有 GPS”。因此这里必须拿到系统直接给出的 speed；
    // 不再读取经纬度计算替代速度，防止仅 Wi-Fi 定位被误判成具备 GPS/GNSS 的设备。
    recordLocationSample(speedKmh, coords.accuracy, null, timestamp, "web");
}

function handleWebLocationError(error) {
    const code = Number(error?.code);
    if (code === 1) {
        lastLocationErrorMessage = "定位权限被拒绝。请修改当前网站和系统定位权限后，点击“检查或重试”。";
        setCapabilityState("location", "blocked", lastLocationErrorMessage);
    } else if (code === 2) {
        lastLocationErrorMessage = "设备暂时无法提供位置。请确认已开启定位服务、处于开阔区域，并检查设备是否具有 GPS/GNSS。";
        setCapabilityState("location", "blocked", lastLocationErrorMessage);
    } else {
        lastLocationErrorMessage = "定位请求超时。请保持页面在前台并到开阔区域重试。";
        setCapabilityState("location", "blocked", lastLocationErrorMessage);
    }
}

function startWebLocationWatch() {
    if (locationWatchId !== null || !navigator.geolocation) return;
    locationWatchId = navigator.geolocation.watchPosition(
        handleWebLocation,
        handleWebLocationError,
        { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
    );
    locationTrackingActive = true;
}

function requestNativeLocationPermission(action = "start") {
    // 受限 WebView 只拦截这个固定地址，不向网页暴露任意原生方法或系统对象。
    window.location.href = `gamebridgeforfun://capability/location/${action}`;
    locationTrackingActive = action === "start";
}

function stopLocationTracking() {
    if (nativeSensorHostEnabled) {
        requestNativeLocationPermission("stop");
    } else if (locationWatchId !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(locationWatchId);
        locationWatchId = null;
    }
    locationTrackingActive = false;
}

async function checkLocationCapability(keepTracking = false) {
    setCapabilityState("location", "checking", "正在请求定位并验证 GPS/GNSS 速度...");
    lastLocationErrorMessage = "";
    locationValidSampleCount = 0;
    locationValidationStartedAt = 0;
    latestLocationSample = null;

    if (nativeSensorHostEnabled) {
        if (!nativeHasGpsHardware) {
            setCapabilityState("location", "blocked", "此 Android 设备没有 GPS/GNSS 硬件，不能使用雷电极速。");
            return false;
        }
        if (!nativeLocationServiceEnabled || nativeLocationPermission !== "granted") {
            requestNativeLocationPermission("start");
        } else {
            requestNativeLocationPermission("start");
        }
    } else {
        if (!window.isSecureContext) {
            setCapabilityState("location", "blocked", "手机浏览器必须通过 HTTPS 打开游戏页才能申请定位；请安装本项目证书后扫描 HTTPS 二维码。");
            return false;
        }
        if (!navigator.geolocation) {
            setCapabilityState("location", "blocked", "当前浏览器没有定位接口，不能使用雷电极速。");
            return false;
        }
        if (locationWatchId !== null) {
            navigator.geolocation.clearWatch(locationWatchId);
            locationWatchId = null;
        }
        startWebLocationWatch();
    }

    await waitUntil(
        () => capabilityState.location.status === "ready" || capabilityState.location.status === "blocked",
        10000
    );
    const ready = capabilityState.location.status === "ready";
    if (!ready && capabilityState.location.status === "checking") {
        const message = latestLocationSample
            ? capabilityState.location.detail
            : "10 秒内没有收到可靠速度。没有 GPS/GNSS、定位服务关闭或当前环境遮挡严重时都不能启动。";
        setCapabilityState("location", "blocked", message);
    }
    if (!keepTracking || !ready) stopLocationTracking();
    return ready;
}

async function checkCapability(name) {
    if (capabilityCheckInProgress && (name === "motion" || name === "location")) {
        setText("capability-message", "另一项权限检查正在进行，请稍等。");
        return false;
    }
    if (!capabilityState[name]) return false;
    if (name === "wake" || name === "vibration") {
        inspectPassiveCapabilities();
        setText("capability-message", "支持情况已更新。");
        return capabilityState[name].status === "ready";
    }

    capabilityCheckInProgress = true;
    try {
        const ok = name === "motion"
            ? await checkMotionCapability()
            : await checkLocationCapability(false);
        setText("capability-message", ok
            ? "能力检查通过。后续如果系统撤销权限或数据中断，游戏仍会立即停止。"
            : "检查未通过。请按提示修改权限或更换具备所需传感器的设备后重试。");
        return ok;
    } finally {
        capabilityCheckInProgress = false;
    }
}

async function runAllCapabilityChecks() {
    if (capabilityCheckInProgress) return;
    inspectPassiveCapabilities();
    const motionOk = await checkCapability("motion");
    const locationOk = await checkCapability("location");
    setText("capability-message", `全部检查完成：动作与方向${motionOk ? "可用" : "未通过"}；GPS/GNSS 速度${locationOk ? "可用" : "未通过"}。不依赖失败能力的玩法仍可使用。`);
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
    enable(hasOrientation = true, hasMotion = true, hasGps = false, locationPermission = "unknown", locationEnabled = false) {
        nativeSensorHostEnabled = true;
        nativeLocationHostEnabled = true;
        nativeHasOrientationSensor = Boolean(hasOrientation);
        nativeHasMotionSensor = Boolean(hasMotion);
        nativeHasGpsHardware = Boolean(hasGps);
        nativeLocationPermission = String(locationPermission);
        nativeLocationServiceEnabled = Boolean(locationEnabled);
        sensorsAllowed = true;
        document.documentElement.classList.add("native-host");
        inspectPassiveCapabilities();
        if (nativeHasOrientationSensor && nativeHasMotionSensor) {
            setCapabilityState("motion", "ready", "Android 原生方向与摇晃传感器均可用。");
        } else if (nativeHasOrientationSensor || nativeHasMotionSensor) {
            setCapabilityState("motion", "partial", "Android 只检测到部分动作传感器，相关玩法会在启动时再次验证。");
        } else {
            setCapabilityState("motion", "blocked", "此 Android 设备没有可用的动作或方向传感器。");
        }
        if (!nativeHasGpsHardware) {
            setCapabilityState("location", "blocked", "此 Android 设备没有 GPS/GNSS 硬件，不能使用雷电极速。");
        } else if (nativeLocationPermission === "denied") {
            setCapabilityState("location", "blocked", "Android 定位权限未允许。请点击检查重试，或到系统设置中修改权限。");
        } else if (!nativeLocationServiceEnabled) {
            setCapabilityState("location", "blocked", "Android 系统定位服务未开启。开启后返回权限中心重试。");
        }
    },
    updateCapabilities(hasOrientation, hasMotion, hasGps, locationPermission, locationEnabled) {
        this.enable(hasOrientation, hasMotion, hasGps, locationPermission, locationEnabled);
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
    receiveLocationSample(speedKmh, accuracyMeters, speedAccuracyKmh, timestamp) {
        if (!nativeLocationHostEnabled) return;
        locationTrackingActive = true;
        const speedAccuracy = Number(speedAccuracyKmh);
        recordLocationSample(
            Number(speedKmh),
            Number(accuracyMeters),
            Number.isFinite(speedAccuracy) && speedAccuracy >= 0 ? speedAccuracy : null,
            Number(timestamp),
            "android_native"
        );
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

function switchSelectionTab(tabName) {
    const validTabs = ["play", "setup", "info"];
    activeSelectionTab = validTabs.includes(tabName) ? tabName : "play";
    const meta = SELECTION_TAB_META[activeSelectionTab];
    setText("selection-title", meta.title);
    setText("selection-context-text", meta.description);

    validTabs.forEach((name) => {
        const tab = $(`selection-tab-${name}`);
        const panel = $(`selection-panel-${name}`);
        const active = name === activeSelectionTab;
        if (tab) {
            tab.setAttribute("aria-selected", String(active));
            tab.tabIndex = active ? 0 : -1;
        }
        if (panel) panel.hidden = !active;
    });
}

function bindRovingTabKeyboard(container, activateTab) {
    if (!container || container.dataset.keyboardBound === "true") return;
    container.dataset.keyboardBound = "true";
    container.addEventListener("keydown", (event) => {
        const tabs = Array.from(container.querySelectorAll("[role='tab']"));
        const currentIndex = tabs.indexOf(event.target);
        if (currentIndex < 0) return;

        let targetIndex = null;
        if (event.key === "ArrowRight") targetIndex = (currentIndex + 1) % tabs.length;
        if (event.key === "ArrowLeft") targetIndex = (currentIndex - 1 + tabs.length) % tabs.length;
        if (event.key === "Home") targetIndex = 0;
        if (event.key === "End") targetIndex = tabs.length - 1;
        if (targetIndex === null) return;

        event.preventDefault();
        const target = tabs[targetIndex];
        activateTab(target.dataset.tabValue);
        target.focus();
    });
}

function showSelectScreen(tabName = "play") {
    if (activeGame === "lightning") stopLocationTracking();
    selectedGame = null;
    lightningSafetyAcceptedForAttempt = false;
    closeLightningSafetyDialog();
    stopRuntimeLoops();
    showScreen("screen-select");
    switchSelectionTab(tabName);
}

function openGameSettings(gameName) {
    selectedGame = gameName;
    activeGame = null;
    lightningSafetyAcceptedForAttempt = false;
    stopRuntimeLoops();

    document.querySelectorAll(".setting-panel").forEach((node) => {
        node.classList.remove("active");
        node.removeAttribute("role");
        node.removeAttribute("aria-labelledby");
    });
    $(`settings-${gameName}`).classList.add("active");

    setText("settings-title", GAME_META[gameName].title);
    setText("settings-subtitle", GAME_META[gameName].subtitle);
    setText("settings-message", "");
    populateSettingsForm(gameName);
    buildSettingsCategoryTabs(gameName);
    updateSettingsActionVisibility(gameName);
    showScreen("screen-settings");
}

function openLightningSafetyDialog() {
    const dialog = $("lightning-safety-dialog");
    if (!dialog) return;
    dialog.querySelectorAll("[data-lightning-safety-check]").forEach((checkbox) => {
        checkbox.checked = false;
    });
    updateLightningSafetyConfirmation();
    if (!dialog.open) dialog.showModal();
}

function closeLightningSafetyDialog() {
    const dialog = $("lightning-safety-dialog");
    if (dialog?.open) dialog.close();
}

function updateLightningSafetyConfirmation() {
    const checks = Array.from(document.querySelectorAll("[data-lightning-safety-check]"));
    const confirmButton = $("lightning-safety-confirm");
    if (confirmButton) confirmButton.disabled = checks.length === 0 || checks.some((item) => !item.checked);
}

async function confirmLightningSafetyAndStart() {
    const checks = Array.from(document.querySelectorAll("[data-lightning-safety-check]"));
    if (checks.length === 0 || checks.some((item) => !item.checked)) return;
    lightningSafetyAcceptedForAttempt = true;
    closeLightningSafetyDialog();
    await startConfiguredGame();
}

function resetSettingsDisclosureState(gameName) {
    // 每次进入设置只展开当前玩法的基础分组，高级规则保持折叠。
    document.querySelectorAll("#screen-settings details.settings-group").forEach((group) => {
        const groupGame = group.dataset.game || "common";
        const shouldOpen = groupGame === gameName && group.dataset.defaultOpen === "true";
        group.open = shouldOpen;
    });
}

function switchSettingsCategory(categoryValue) {
    if (!selectedGame) return;
    const layout = SETTINGS_CATEGORY_LAYOUT[selectedGame] || [];
    const requestedIndex = Number.parseInt(categoryValue, 10);
    const categoryIndex = Number.isInteger(requestedIndex) && requestedIndex >= 0 && requestedIndex < layout.length
        ? requestedIndex
        : 0;
    const category = layout[categoryIndex];
    const panel = $(`settings-${selectedGame}`);
    const groups = Array.from(panel?.querySelectorAll("details.settings-group") || []);

    groups.forEach((group, groupIndex) => {
        const visible = category.groupIndexes.includes(groupIndex);
        group.hidden = !visible;
        group.open = visible && groupIndex === category.groupIndexes[0];
    });

    const tabs = Array.from($("settings-tabs")?.querySelectorAll("[role='tab']") || []);
    tabs.forEach((tab, tabIndex) => {
        const active = tabIndex === categoryIndex;
        tab.setAttribute("aria-selected", String(active));
        tab.tabIndex = active ? 0 : -1;
    });
    if (panel && tabs[categoryIndex]) panel.setAttribute("aria-labelledby", tabs[categoryIndex].id);
}

function buildSettingsCategoryTabs(gameName) {
    const tabList = $("settings-tabs");
    const panel = $(`settings-${gameName}`);
    const layout = SETTINGS_CATEGORY_LAYOUT[gameName] || [];
    if (!tabList || !panel || layout.length === 0) return;

    resetSettingsDisclosureState(gameName);
    tabList.replaceChildren();
    tabList.style.setProperty("--settings-tab-count", String(layout.length));
    panel.setAttribute("role", "tabpanel");

    layout.forEach((category, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.id = `settings-tab-${gameName}-${index}`;
        button.dataset.tabValue = String(index);
        button.setAttribute("role", "tab");
        button.setAttribute("aria-controls", panel.id);
        button.setAttribute("aria-selected", String(index === 0));
        button.tabIndex = index === 0 ? 0 : -1;
        button.innerText = category.label;
        button.addEventListener("click", () => switchSettingsCategory(index));
        tabList.appendChild(button);
    });

    bindRovingTabKeyboard(tabList, switchSettingsCategory);
    switchSettingsCategory(0);
}

function updateSettingsActionVisibility(gameName) {
    const calibrateButton = $("settings-calibrate-button");
    if (!calibrateButton) return;
    const shouldShowCalibration = gameName === "shake";
    calibrateButton.hidden = !shouldShowCalibration;
    $("screen-settings")?.querySelector(".settings-actions")?.classList.toggle(
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
        updateShakeModeVisibility();
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
    } else if (gameName === "lightning") {
        const normalized = normalizeLightningSettings(cfg, DEFAULT_SETTINGS.lightning);
        gameSettings.lightning = normalized;
        setRangeValue("lightning-start-speed", normalized.startSpeed);
        setRangeValue("lightning-start-strength", normalized.startStrength);
        setRangeValue("lightning-max-strength", normalized.maxStrength);
        setRangeValue("lightning-full-speed", normalized.fullSpeed);
        setRangeValue("lightning-continuous-seconds", normalized.continuousSeconds);
        setRangeValue("lightning-driving-rest-seconds", normalized.drivingRestSeconds);
        setRangeValue("lightning-overspeed-recovery-seconds", normalized.overspeedRecoverySeconds);
        setRangeValue("lightning-session-minutes", normalized.sessionMinutes);
        $("lightning-jam-enabled").checked = normalized.jamEnabled;
        setRangeValue("lightning-jam-strength", normalized.jamStrength);
        setRangeValue("lightning-jam-entry-seconds", normalized.jamEntrySeconds);
        setRangeValue("lightning-jam-shock-seconds", normalized.jamShockSeconds);
        setRangeValue("lightning-jam-gap-min-seconds", normalized.jamGapMinSeconds);
        setRangeValue("lightning-jam-gap-max-seconds", normalized.jamGapMaxSeconds);
        setRangeValue("lightning-jam-batch-count", normalized.jamBatchCount);
        setRangeValue("lightning-jam-batch-rest-seconds", normalized.jamBatchRestSeconds);
        updateLightningJamVisibility();
    }
}

function updateShakeModeVisibility() {
    const gapSetting = $("shake-gap-inner-setting");
    if (gapSetting) gapSetting.hidden = $("shake-mode")?.value !== "gap";
}

function updateLightningJamVisibility() {
    const options = $("lightning-jam-options");
    const enabled = Boolean($("lightning-jam-enabled")?.checked);
    if (options) options.hidden = !enabled;
    const summary = $("lightning-jam-settings")?.querySelector("summary small");
    if (summary) summary.innerText = enabled ? "强度、触发间隔与整轮休息" : "默认关闭";
}

function populateGlobalOutputForm() {
    if (!$("global-output-mode")) return;

    $("global-output-mode").value = globalOutputSettings.outputMode || DEFAULT_OUTPUT_SETTINGS.outputMode;
    $("global-waveform").value = selectedWaveform;
    refreshGlobalOutputPresentation();
}

function refreshGlobalOutputPresentation() {
    const summary = formatGlobalOutputSummary();
    setText("global-output-summary", summary);
    setText("settings-global-output-summary", summary);
    setText("quick-banner-summary", summary);

    const warning = $("global-output-confirmation-warning");
    const confirmButton = $("global-output-confirm-button");
    if (warning) warning.hidden = !globalOutputRequiresConfirmation;
    if (confirmButton) confirmButton.hidden = !globalOutputRequiresConfirmation;

    const group = $("global-output-settings");
    if (group && globalOutputRequiresConfirmation) {
        group.open = true;
    }
}

function showGlobalOutputSettings() {
    showSelectScreen("setup");
    const group = $("global-output-settings");
    if (!group) return;
    group.open = true;
    window.requestAnimationFrame(() => group.querySelector("summary")?.focus({ preventScroll: true }));
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
    if (selectedGame === "shake") {
        calibrateCurrentPose(selectedGame);
    }
}

function resetSelectedSettings() {
    if (!selectedGame || !DEFAULT_SETTINGS[selectedGame]) return;

    // 当前配置全部由原始值组成，浅复制即可生成独立对象，不会反向修改默认配置。
    gameSettings[selectedGame] = { ...DEFAULT_SETTINGS[selectedGame] };
    persistSettings();
    populateSettingsForm(selectedGame);
    const activeTab = $("settings-tabs")?.querySelector("[role='tab'][aria-selected='true']");
    const categoryIndex = activeTab?.dataset.tabValue ? Number.parseInt(activeTab.dataset.tabValue, 10) : 0;
    switchSettingsCategory(categoryIndex);
    refreshGlobalSafetyStatus();
    setText("settings-message", "已恢复当前玩法的默认设置");
}

function collectGlobalOutputSettings() {
    const outputMode = ["a", "b", "ab"].includes($("global-output-mode").value)
        ? $("global-output-mode").value
        : DEFAULT_OUTPUT_SETTINGS.outputMode;

    return {
        outputMode
    };
}

function saveGlobalOutputSettings(silent = false) {
    globalOutputSettings = collectGlobalOutputSettings();
    persistGlobalOutputSettings();
    refreshGameStrengthLimit();
    refreshGlobalOutputPresentation();
    refreshGlobalSafetyStatus();

    if (!silent) {
        setText("global-output-message", globalOutputRequiresConfirmation
            ? "设置已保存。请核对接线后点击“确认全局输出”。"
            : "全局输出设置已保存，所有玩法立即共用。"
        );
    }
}

function confirmGlobalOutputSettings() {
    globalOutputSettings = collectGlobalOutputSettings();
    globalOutputRequiresConfirmation = false;
    persistGlobalOutputSettings();
    refreshGameStrengthLimit();
    refreshGlobalOutputPresentation();
    refreshGlobalSafetyStatus();
    setText("global-output-message", "全局输出通道已确认，所有玩法立即共用。");
}

function saveSelectedSettings(silent = false) {
    if (!selectedGame) return;

    const cfg = collectSettingsFromForm(selectedGame);
    const effectiveLimit = getCurrentEffectiveStrengthLimit();
    gameSettings[selectedGame] = effectiveLimit > 0
        ? clampGameStrengthSettings({ [selectedGame]: cfg }, effectiveLimit)[selectedGame]
        : cfg;
    persistSettings();
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
            strengthMin: Math.min(minStrength, maxStrength),
            strengthMax: Math.max(minStrength, maxStrength),
            mode: $("shake-mode").value,
            safeRadius: clamp(readNumber("shake-safe-radius", 26), 12, 45),
            gapInner: clamp(readNumber("shake-gap-inner", 12), 6, 28),
            sensitivity: clamp(readNumber("shake-sensitivity", 55), 20, 100),
            forgiveMs: clamp(readNumber("shake-forgive-ms", 600), 0, 2000)
        };
    }

    if (gameName === "dice") {
        return {
            strength: clamp(readNumber("dice-strength", 20), 0, 200),
            singleSeconds: clamp(readNumber("dice-single-seconds", 2.0), 1.0, 30.0),
            gapSeconds: clamp(readNumber("dice-gap-seconds", 0.5), 0.2, 3.0),
            leopardMultiplier: clamp(readNumber("dice-leopard-multiplier", 3), 1, 6),
            maxPunishCount: clamp(readNumber("dice-max-punish-count", 30), 1, 36),
            shakeSensitivity: clamp(readNumber("dice-shake-sensitivity", 15), 8, 35),
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
            shockSeconds: clamp(readNumber("slot-shock-seconds", 2.0), 1.0, 30.0),
            lightPunishEnabled: $("slot-light-punish-enabled").checked,
            lightShockSeconds: clamp(readNumber("slot-light-shock-seconds", 1.0), 1.0, 2.0),
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

    if (gameName === "lightning") {
        return normalizeLightningSettings({
            startSpeed: readNumber("lightning-start-speed", 10),
            startStrength: readNumber("lightning-start-strength", 20),
            maxStrength: readNumber("lightning-max-strength", 80),
            fullSpeed: readNumber("lightning-full-speed", 50),
            continuousSeconds: readNumber("lightning-continuous-seconds", 8),
            drivingRestSeconds: readNumber("lightning-driving-rest-seconds", 3),
            overspeedRecoverySeconds: readNumber("lightning-overspeed-recovery-seconds", 10),
            sessionMinutes: readNumber("lightning-session-minutes", 10),
            jamEnabled: Boolean($("lightning-jam-enabled")?.checked),
            jamStrength: readNumber("lightning-jam-strength", 30),
            jamEntrySeconds: readNumber("lightning-jam-entry-seconds", 40),
            jamShockSeconds: readNumber("lightning-jam-shock-seconds", 1.5),
            jamGapMinSeconds: readNumber("lightning-jam-gap-min-seconds", 12),
            jamGapMaxSeconds: readNumber("lightning-jam-gap-max-seconds", 25),
            jamBatchCount: readNumber("lightning-jam-batch-count", 5),
            jamBatchRestSeconds: readNumber("lightning-jam-batch-rest-seconds", 60)
        }, DEFAULT_SETTINGS.lightning);
    }

    return { ...DEFAULT_SETTINGS[gameName] };
}

async function calibrateCurrentPose(gameName) {
    if (gameName !== "shake") return;
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

        calibration.shakeBeta = phoneBeta;
        calibration.shakeGamma = phoneGamma;

        setText("settings-message", "已使用当前握持姿态作为基准");
        if (activeGame === "shake") {
            setGamePhase("ready", "已校准当前握持姿态为中心");
        }
    } finally {
        sensorActionInProgress = false;
    }
}

async function startConfiguredGame() {
    if (!selectedGame) return;
    if (globalOutputRequiresConfirmation) {
        setText("settings-message", "全局输出通道尚未确认；请先点击“修改全局设置”并核对实际接线。");
        return;
    }
    if (sensorActionInProgress) {
        setText("settings-message", "感应器请求正在处理中，请稍等。");
        return;
    }

    if (selectedGame === "lightning" && !lightningSafetyAcceptedForAttempt) {
        openLightningSafetyDialog();
        return;
    }

    const gameName = selectedGame;
    sensorActionInProgress = true;
    try {
        saveSelectedSettings(true);
        // 手动骰子不消费摇晃数据，不应为了一个关闭的可选功能索要传感器权限。
        const needsSensors = gameName === "shake" ||
            (gameName === "dice" && !gameSettings.dice.manualRoll);
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
            if (!ready && gameName === "shake") {
                setText("settings-message", getSensorNotReadyMessage(gameName));
                return;
            }

            if (!ready && gameName === "dice" && !gameSettings.dice.manualRoll) {
                setText("settings-message", "未收到摇晃感应数据；请先开启手动摇号，或检查手机动作感应权限");
                return;
            }

            if (!ready && gameName === "dice") {
                setText("settings-message", "未收到摇晃感应数据，进入后仍可用手动摇号");
            }
        }


        if (gameName === "lightning") {
            setText("settings-message", "正在检查 GPS/GNSS 和可靠速度数据...");
            const hasFreshLocation = locationTrackingActive &&
                capabilityState.location.status === "ready" &&
                latestLocationSample?.valid === true &&
                isTimestampFresh(latestLocationSample.timestamp, 3000);
            const locationReady = hasFreshLocation
                ? true
                : await checkLocationCapability(true);
            if (!locationReady) {
                setText("settings-message", capabilityState.location.detail);
                showCapabilityCenter(capabilityState.location.detail);
                return;
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

        // 每次开始时自动用当前姿态兜底校准，避免玩家刚进入就因为初始握法被误罚。
        if (activeGame === "shake") {
            calibration.shakeBeta = phoneBeta;
            calibration.shakeGamma = phoneGamma;
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
    setText("summary-output", formatOutputLabel(globalOutputSettings));
    setText("summary-waveform", formatWaveformLabel(selectedWaveform));

    $("game-viewport").style.display = gameName === "shake" ? "block" : "none";
    $("dice-viewport").style.display = gameName === "dice" ? "block" : "none";
    $("slot-viewport").style.display = gameName === "slot" ? "block" : "none";
    $("lightning-viewport").style.display = gameName === "lightning" ? "block" : "none";

    const playCalibrateBtn = $("play-calibrate-btn");
    if (playCalibrateBtn) {
        playCalibrateBtn.style.display = gameName === "shake" ? "inline-flex" : "none";
    }

    stopRuntimeLoops();

    if (gameName === "shake") {
        setGamePhase("ready", "保持弹珠停留在安全区内");
        initShakeGame();
    } else if (gameName === "dice") {
        setGamePhase("ready", motionReady ? "摇晃手机开始对决" : "未收到摇晃感应，可先手动摇号");
        initDiceGame();
    } else if (gameName === "slot") {
        setGamePhase("ready", "点击开转，高频开奖");
        initSlotGame();
    } else if (gameName === "lightning") {
        setGamePhase("checking", "等待可靠速度达到启动值并稳定 2 秒");
        initLightningGame();
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
    clearInterval(lightningLoopTimer);
    lightningLoopTimer = null;
    lightningState = null;
    lightningNextOutputAt = 0;
    lightningJamBatchCount = 0;
    lightningJamBatchRestUntil = 0;
    lightningLastMode = "";
    lightningResumeFromJam = false;
    lightningOutputPending = false;
    lightningCurrentOutputUntil = 0;
    lightningLastSafetySampleAt = 0;
    nextPulseAllowedAt = 0;
    sensorStopRequestedForStaleData = false;
    slotOutputUntil = 0;
    slotRestUntil = 0;
    diceRoundId = "";
    dicePunishSequence = 0;
    pendingStandaloneRequests.clear();
    pendingLightningRequests.clear();
}

function exitGame() {
    stopCurrentGame();
    showSelectScreen();
}

function stopCurrentGame() {
    if (activeGame === "lightning") {
        stopLocationTracking();
        endLightningSession("leave_game");
    }
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
    setGamePhase("stopped", "已停止输出");
    setText("global-safety-status", "已请求停止 A/B 输出");
}

function endLightningSession(reason) {
    if (!lightningSessionId) return;
    sendGameMessage({
        type: "lightning_session_end",
        sessionId: lightningSessionId,
        reason
    });
    lightningSessionId = "";
    lightningLastSafetySampleAt = 0;
}

// --- 6. 统一惩罚发送与本机震动 ---

function canPunish(requiresOrientation = true) {
    if (!activeGame) return false;
    if (requiresOrientation && !hasFreshOrientation()) {
        // 页面仍在线但原生传感器或浏览器权限流已经停更时，WebSocket 心跳还会继续。
        // 因此这里必须单独发一次停止命令，并清掉旧的出界计时，不能让最后一帧坏姿态无限续罚。
        shakeOutSince = null;
        if (!sensorStopRequestedForStaleData) {
            sensorStopRequestedForStaleData = true;
            sendGameMessage({ type: "stop_shock" });
            setGamePhase("paused", "感应器数据已中断，输出已停止；恢复后重新计时");
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

    const effectiveLimit = getCurrentEffectiveStrengthLimit();
    const safeStrength = clamp(Math.round(strength), 0, effectiveLimit);
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
    return {
        outputMode: globalOutputSettings.outputMode || DEFAULT_OUTPUT_SETTINGS.outputMode,
        waveform: selectedWaveform
    };
}

function sendConfiguredShock(strength, duration, metadata = {}) {
    const effectiveLimit = getCurrentEffectiveStrengthLimit();
    const safeStrength = clamp(Math.round(strength), 0, effectiveLimit);
    if (safeStrength <= 0) return false;
    // 发送前再次确认硬件就绪状态，防止 App 已扫码但蓝牙设备离线时空发。
    if (!latestDeviceConnected || !isConfiguredOutputReady()) return false;

    const requestId = ++standaloneRequestSequence;
    const sent = sendGameMessage({
        ...metadata,
        type: "game_shock_trigger",
        requestId,
        strength: safeStrength,
        duration: Math.round(duration),
        ...getOutputPayload()
    });
    if (sent) pendingStandaloneRequests.set(requestId, { ...metadata });
    return sent;
}

function formatOutputLabel(cfg) {
    const mode = cfg.outputMode || "a";
    if (mode === "b") {
        return "只用 B";
    }
    if (mode === "ab") {
        return "A+B 同时";
    }
    return "只用 A";
}

function formatWaveformLabel(value) {
    const key = normalizeWaveformKey(value);
    return WAVEFORM_LABELS[key];
}

function formatGlobalOutputSummary() {
    return `${formatWaveformLabel(selectedWaveform)} · ${formatOutputLabel(globalOutputSettings)}`;
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

    // 浅灰底色画布
    ctx.fillStyle = "#F8FAFC";
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
    const dangerAlpha = 0.08 + zone.dangerRatio * 0.22;

    if (zone.err > 0) {
        ctx.fillStyle = `rgba(239, 68, 68, ${dangerAlpha})`;
        ctx.fillRect(0, 0, width, height);
    }

    // 现代网格线
    ctx.strokeStyle = "#E2E8F0";
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

    // 中心十字准星
    ctx.strokeStyle = zone.err > 0 ? "rgba(239, 68, 68, 0.4)" : "#94A3B8";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(zone.centerX - 16, zone.centerY);
    ctx.lineTo(zone.centerX + 16, zone.centerY);
    ctx.moveTo(zone.centerX, zone.centerY - 16);
    ctx.lineTo(zone.centerX, zone.centerY + 16);
    ctx.stroke();

    // 绘制安全区圆环
    const isDanger = zone.err > 0;
    ctx.fillStyle = isDanger ? "rgba(239, 68, 68, 0.08)" : "rgba(16, 185, 129, 0.08)";
    ctx.strokeStyle = isDanger ? "#EF4444" : "#10B981";
    ctx.lineWidth = 2.5;

    ctx.beginPath();
    if (cfg.mode === "radius") {
        ctx.arc(zone.centerX, zone.centerY, zone.outer, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
    } else {
        ctx.arc(zone.centerX, zone.centerY, zone.inner, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(zone.centerX, zone.centerY, zone.outer, 0, Math.PI * 2);
        ctx.stroke();
    }

    // 绘制 3D 质感蓝色/红色弹珠
    ctx.shadowBlur = isDanger ? 12 : 8;
    ctx.shadowColor = isDanger ? "rgba(239, 68, 68, 0.5)" : "rgba(37, 99, 235, 0.35)";
    ctx.fillStyle = isDanger ? "#EF4444" : "#2563EB";
    ctx.beginPath();
    ctx.arc(ballX, ballY, ballRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // 弹珠高光点
    ctx.fillStyle = "#FFFFFF";
    ctx.beginPath();
    ctx.arc(ballX - 2.5, ballY - 2.5, 2.2, 0, Math.PI * 2);
    ctx.fill();

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
        setGamePhase("ready", "安全区内");
        return;
    }

    if (shakeOutSince === null) {
        shakeOutSince = Date.now();
        setGamePhase("checking", "已出界，等待持续判定");
        return;
    }

    const elapsed = Date.now() - shakeOutSince;
    if (elapsed < cfg.forgiveMs) {
        const remain = Math.ceil((cfg.forgiveMs - elapsed) / 100) / 10;
        setGamePhase("checking", `已出界，约 ${remain.toFixed(1)}s 后触发`);
        vibrateWarning();
        return;
    }

    const ratio = zone.dangerRatio;
    const strength = cfg.strengthMin + (cfg.strengthMax - cfg.strengthMin) * ratio;
    setGamePhase("output", `持续出界，当前强度 ${Math.round(strength)}`);
    sendPulse(strength, 120, SENSOR_CONTROL_FRAME_REST_MS);
}

// --- 8. 游戏 2：摇骰子对决 ---

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
        setGamePhase("drawing", "骰子正在滚动");
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
    setGamePhase("drawing", "骰子正在滚动");
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
        setGamePhase("ready", "本局无需输出");
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
    const plan = calculateDiceExecutionPlan(rawCount, cfg, DICE_OUTPUT_BUDGET_SECONDS);
    const cappedCount = plan.executionCount;

    if (cappedCount <= 0) {
        setText("dice-instruction", "没有惩罚");
        $("dice-instruction").style.color = "#ffffff";
        setGamePhase("ready", "本局无需输出");
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
    diceRoundId = createRuntimeId("dice");
    dicePunishSequence = 0;
    sendGameMessage({
        type: "dice_round_start",
        roundId: diceRoundId,
        plannedCount: cappedCount,
        singleDuration: Math.round(plan.singleSeconds * 1000)
    });
    const cappedText = plan.truncated ? `，按次数或 300 秒总量截到 ${cappedCount} 下` : "";
    const estimateSeconds = estimateDiceQueueSeconds(cappedCount, cfg);
    setText("dice-instruction", `${reason} | 准备执行 ${cappedCount} 下，输出共 ${plan.outputSeconds.toFixed(1)}s，含间隔约 ${estimateSeconds.toFixed(1)}s${cappedText}`);
    $("dice-instruction").style.color = "#ff3333";
    $("btn-roll").disabled = true;
    setGamePhase("checking", "本局惩罚准备中");
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
    const sequence = ++dicePunishSequence;
    const sent = sendConfiguredShock(cfg.strength, totalDuration, {
        game: "dice",
        phase: "dice_hit",
        roundId: diceRoundId,
        sequence,
        plannedCount: sequence + dicePunishRemaining - 1
    });
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

    setGamePhase("output", `骰子第 ${sequence} 下`);

    if (navigator.vibrate) {
        navigator.vibrate(Math.min(900, totalDuration));
    }

    dicePunishRemaining -= 1;
    dicePunishTimer = setTimeout(() => {
        dicePunishTimer = null;
        if (activeGame !== "dice" || generation !== dicePunishGeneration) {
            return;
        }

        if (dicePunishRemaining <= 0) {
            setText("dice-instruction", "本局惩罚结束");
            $("dice-instruction").style.color = "#888888";
            $("btn-roll").disabled = !gameSettings.dice.manualRoll;
            setGamePhase("ready", "本局惩罚结束");
            return;
        }

        setGamePhase("interval", "等待下一下");
        setText("dice-instruction", `间隔中 | 剩余 ${dicePunishRemaining} 下`);
        dicePunishTimer = setTimeout(() => {
            dicePunishTimer = null;
            runNextDicePunish(generation);
        }, gapDuration);
    }, totalDuration);
}

// --- 9. 游戏 3：极速角子机 ---

function beginSlotOutputCycle(duration, restMs, onComplete) {
    // 输出和输出后的休息必须使用两个清晰阶段，不能再共用一个“冷却截止时间”。
    // 这样 30 秒长惩罚期间页面会准确显示“输出中”，而不是提前写成“休息中”。
    const safeDuration = Math.max(0, Math.round(duration));
    const safeRestMs = Math.max(0, Math.round(restMs));
    const now = Date.now();
    slotOutputUntil = now + safeDuration;
    slotRestUntil = slotOutputUntil + safeRestMs;
    slotCooldownUntil = slotRestUntil;
    setGamePhase("output", "角子机正在执行本轮输出");

    const button = $("btn-slot-spin");
    if (button) {
        button.disabled = true;
        button.innerText = "输出中";
    }

    clearTimeout(slotCooldownTimer);
    slotCooldownTimer = setTimeout(() => {
        slotCooldownTimer = null;
        if (activeGame !== "slot") return;

        if (safeRestMs > 0) {
            setGamePhase("rest", "角子机强制休息");
            if (button) button.innerText = "休息中";
        }

        slotCooldownTimer = setTimeout(() => {
            slotCooldownTimer = null;
            if (activeGame !== "slot") return;
            slotCooldownUntil = 0;
            slotOutputUntil = 0;
            slotRestUntil = 0;
            onComplete();
        }, safeRestMs);
    }, safeDuration);
}

function initSlotGame() {
    slotPressure = 0;
    slotMissStreak = 0;
    slotIsSpinning = false;
    slotCooldownUntil = 0;
    slotLightCooldownUntil = 0;
    slotOutputUntil = 0;
    slotRestUntil = 0;
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
        const outputActive = now < slotOutputUntil;
        setGamePhase(outputActive ? "output" : "rest", outputActive ? "角子机正在输出" : "角子机强制休息");
        setText("slot-result", outputActive ? "本轮输出尚未结束。" : "休息尚未结束。" );
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

    setGamePhase("drawing", "角子机高速转动中");
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
    if (gameSettings.slot.autoSpin) {
        scheduleNextSlotSpin(gameSettings.slot.autoIntervalMs);
    } else {
        if (button) {
            button.disabled = false;
            button.innerText = "开转";
        }
        setGamePhase("ready", "可以开始下一轮");
    }
}

function scheduleNextSlotSpin(delayMs) {
    clearTimeout(slotAutoTimer);
    slotAutoTimer = null;

    if (activeGame !== "slot" || !gameSettings.slot.autoSpin) return;

    const cooldownDelay = Math.max(0, slotCooldownUntil - Date.now());
    const safeDelay = Math.max(delayMs, cooldownDelay);
    const button = $("btn-slot-spin");
    if (button) {
        button.disabled = true;
        button.innerText = "间隔中";
    }
    setGamePhase("interval", "等待自动连转下一轮");
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
        triggerSlotPunish(nextState.punishmentReason);
        return true;
    }

    const lightResult = resultType === "miss" && cfg.lightPunishEnabled
        ? triggerSlotLightPunish()
        : { message: "", sent: false };
    if (resultType === "miss" && slotPressure >= 72) {
        vibrateWarning(28, 360);
    }
    if (lightResult.message) {
        setText("slot-result", `${lightResult.message} | 压力 ${Math.round(slotPressure)}%`);
    }
    return lightResult.sent;
}

function triggerSlotLightPunish() {
    const cfg = gameSettings.slot;
    const now = Date.now();
    if (now < slotLightCooldownUntil) return { message: "轻电仍在休息中", sent: false };

    const duration = Math.round(cfg.lightShockSeconds * 1000);
    const sent = sendConfiguredShock(cfg.strengthMin, duration, {
        game: "slot",
        phase: "slot_light"
    });
    if (sent) {
        const nextAllowedAt = now + duration + cfg.restMs;
        slotLightCooldownUntil = nextAllowedAt;
        slotCooldownUntil = Math.max(slotCooldownUntil, nextAllowedAt);
        vibratePattern([30], 80);
        beginSlotOutputCycle(duration, cfg.restMs, () => {
            slotLightCooldownUntil = 0;
            setText("slot-result", `轻电与休息结束 | 压力 ${Math.round(slotPressure)}%`);
            finishSlotRound();
        });
    } else {
        setGamePhase("blocked", getOutputBlockReason() || "输出忙");
    }

    return {
        sent,
        message: sent
            ? `没中奖轻电：强度 ${cfg.strengthMin}，${cfg.lightShockSeconds.toFixed(1)}s`
            : `${getOutputBlockReason() || "输出忙"}，未输出`
    };
}

function triggerSlotPunish(reason) {
    const cfg = gameSettings.slot;
    const duration = Math.round(cfg.shockSeconds * 1000);
    // 所有满槽惩罚都使用用户设置的“满槽惩罚强度”；200 只是可设置上限，后端仍会按硬件限幅截断。
    const strength = Math.round(cfg.strengthMax);
    const sent = sendConfiguredShock(strength, duration, {
        game: "slot",
        phase: "slot_full"
    });
    const shouldClearPressure = cfg.pressureAfterPunish !== "keep";
    const outputBlockReason = getOutputBlockReason() || "输出忙";

    if (sent) setGamePhase("output", `${reason}，请求强度 ${strength}`);
    else setGamePhase("blocked", `${reason}，${outputBlockReason}`);
    setText("slot-result", sent ? `${reason} | 请求强度 ${strength}，${(duration / 1000).toFixed(1)}s；实际受 App 限幅` : `${reason} | ${outputBlockReason}，未输出`);
    vibratePattern([120, 45, 180, 45, Math.min(240, duration)], 0);

    if (!sent) {
        // 只有真实完成惩罚后才执行“清空压力”；断线或输出忙不能让本局无代价结算。
        settleSlotPressureAfterPunish(false, `${reason} | ${outputBlockReason}，未实际输出，压力保留 100%`);
        finishSlotRound();
        return;
    }

    beginSlotOutputCycle(duration, cfg.restMs, () => {
        setSlotResultState("");
        settleSlotPressureAfterPunish(
            shouldClearPressure,
            shouldClearPressure ? "惩罚结束，压力清零。" : "惩罚结束，压力保留 100%。"
        );
        finishSlotRound();
    });
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

// --- 10. 游戏 4：雷电极速 ---

function initLightningGame() {
    if (!locationTrackingActive) {
        if (nativeSensorHostEnabled) requestNativeLocationPermission("start");
        else startWebLocationWatch();
    }
    const now = Date.now();
    lightningSessionId = createRuntimeId("lightning");
    lightningLastSafetySampleAt = 0;
    sendGameMessage({
        type: "lightning_session_start",
        sessionId: lightningSessionId,
        sessionMinutes: gameSettings.lightning.sessionMinutes,
        startSpeed: gameSettings.lightning.startSpeed
    });
    lightningState = createLightningState(now);
    lightningNextOutputAt = now + 1200;
    lightningJamBatchCount = 0;
    lightningJamBatchRestUntil = 0;
    lightningLastMode = "";
    lightningOutputPending = false;
    lightningCurrentOutputUntil = 0;
    setText("lightning-speed", "--");
    setText("lightning-strength", "0");
    setText("lightning-mode", "等待可靠速度");
    setText("lightning-location-quality", "正在读取 GPS/GNSS");
    setText("lightning-next-action", "达到启动速度并稳定 2 秒");
    clearInterval(lightningLoopTimer);
    lightningLoopTimer = setInterval(runLightningLoop, 250);
    runLightningLoop();
}

function requestLightningStop(reason, message) {
    lightningOutputPending = false;
    lightningCurrentOutputUntil = 0;
    lightningNextOutputAt = Math.max(lightningNextOutputAt, Date.now() + 500);
    sendGameMessage({ type: "stop_shock", reason });
    if (message) setGamePhase("paused", message);
}

function randomBetween(minimum, maximum) {
    const low = Math.min(minimum, maximum);
    const high = Math.max(minimum, maximum);
    return low + Math.random() * (high - low);
}

function sendLightningOutput(phase, strength, durationSeconds, restSeconds) {
    const requestId = ++lightningRequestSequence;
    const now = Date.now();
    const sampleAgeMs = latestLocationSample
        ? Math.max(0, now - Number(latestLocationSample.timestamp))
        : Number.POSITIVE_INFINITY;
    const effectiveLimit = getCurrentEffectiveStrengthLimit();
    const safeStrength = clamp(Math.round(strength), 0, effectiveLimit);
    if (safeStrength <= 0) return false;
    const sent = sendGameMessage({
        type: "lightning_shock_trigger",
        requestId,
        phase,
        strength: safeStrength,
        duration: Math.round(durationSeconds * 1000),
        restMs: Math.round(restSeconds * 1000),
        sessionId: lightningSessionId,
        // 后端不接收坐标，只用速度与样本年龄做第二道安全校验。
        speedKmh: latestLocationSample?.speedKmh,
        sampleAgeMs,
        ...getOutputPayload()
    });
    if (!sent) return false;

    pendingLightningRequests.set(requestId, lightningSessionId);
    lightningOutputPending = true;
    lightningCurrentOutputUntil = now + durationSeconds * 1000;
    lightningNextOutputAt = lightningCurrentOutputUntil + restSeconds * 1000;
    return true;
}

function sendLightningSafetySample(result, now) {
    // 长输出期间不能只相信开始瞬间的速度。每秒向后台续报一次脱敏状态，
    // 后台只在收到新鲜、合规的样本后才继续维持本次输出。
    if (!lightningSessionId || now - lightningLastSafetySampleAt < 1000) return;
    lightningLastSafetySampleAt = now;
    const sampleAgeMs = latestLocationSample
        ? Math.max(0, now - Number(latestLocationSample.timestamp))
        : null;
    sendGameMessage({
        type: "lightning_safety_sample",
        sessionId: lightningSessionId,
        mode: result.state.mode,
        speedKmh: result.sampleValid ? result.state.lastSpeedKmh : null,
        sampleAgeMs: Number.isFinite(sampleAgeMs) ? sampleAgeMs : null
    });
}

function formatLightningMode(mode) {
    return {
        waiting_speed: "等待启动速度",
        driving: "正常行驶",
        low_pending: "低速确认中",
        low_paused: "低速暂停",
        jam: "堵车模式",
        overspeed: "超速暂停",
        gps_blocked: "定位安全暂停",
        session_complete: "本局已结束"
    }[mode] || "安全暂停";
}

function updateLightningDashboard(result, cfg, now) {
    const sample = latestLocationSample;
    setText("lightning-speed", result.sampleValid ? result.state.lastSpeedKmh.toFixed(1) : "--");
    setText("lightning-strength", String(result.strength || 0));
    setText("lightning-mode", formatLightningMode(result.state.mode));
    setText(
        "lightning-location-quality",
        result.sampleValid && sample?.accuracyMeters !== null
            ? `有效 · 约 ${Math.round(sample.accuracyMeters)} 米`
            : "无有效速度"
    );

    let nextAction = "保持页面在前台";
    let phase = "checking";
    let phaseDetail = "等待速度与定位判定";
    if (result.state.mode === "waiting_speed") {
        const candidateAt = result.state.startCandidateSince;
        nextAction = candidateAt === null
            ? `达到 ${cfg.startSpeed} km/h`
            : `稳定验证 ${Math.max(0, (2000 - (now - candidateAt)) / 1000).toFixed(1)}s`;
        phaseDetail = "等待达到启动速度";
    } else if (result.state.mode === "overspeed") {
        const recoveryAt = result.state.overspeedRecoverySince;
        nextAction = recoveryAt === null
            ? `低于 60 后等待 ${cfg.overspeedRecoverySeconds}s`
            : `恢复倒计时 ${Math.max(0, cfg.overspeedRecoverySeconds - (now - recoveryAt) / 1000).toFixed(1)}s`;
        phase = "paused";
        phaseDetail = "达到 60 km/h，等待恢复";
    } else if (result.state.mode === "low_pending") {
        nextAction = `低速暂停确认 ${Math.max(0, 5 - (now - result.state.lowSince) / 1000).toFixed(1)}s`;
        phase = "paused";
        phaseDetail = "速度低于启动值";
    } else if (result.state.mode === "low_paused" && cfg.jamEnabled) {
        nextAction = `堵车模式还有 ${Math.max(0, cfg.jamEntrySeconds - (now - result.state.lowSince) / 1000).toFixed(0)}s`;
        phase = "paused";
        phaseDetail = "低速暂停，等待堵车规则";
    } else if (result.state.mode === "low_paused") {
        nextAction = "速度恢复后重新判断";
        phase = "paused";
        phaseDetail = "低速暂停";
    } else if (result.state.mode === "jam") {
        if (lightningOutputPending) {
            nextAction = `本轮 ${lightningJamBatchCount}/${cfg.jamBatchCount}`;
            phase = "output";
            phaseDetail = "堵车随机输出";
        } else if (now < lightningJamBatchRestUntil) {
            nextAction = `整轮休息 ${Math.ceil((lightningJamBatchRestUntil - now) / 1000)}s`;
            phase = "rest";
            phaseDetail = "堵车整轮休息";
        } else if (now < lightningNextOutputAt) {
            nextAction = `本轮 ${lightningJamBatchCount}/${cfg.jamBatchCount}`;
            phase = "interval";
            phaseDetail = "堵车随机间隔";
        } else {
            phase = "ready";
            phaseDetail = "准备堵车随机输出";
        }
    } else if (result.state.mode === "driving") {
        if (lightningOutputPending) {
            nextAction = "当前一轮正在输出";
            phase = "output";
            phaseDetail = "按当前速度输出";
        } else if (now < lightningNextOutputAt) {
            nextAction = `强制休息 ${Math.ceil((lightningNextOutputAt - now) / 1000)}s`;
            phase = "rest";
            phaseDetail = "行驶强制休息";
        } else {
            nextAction = "准备下一轮输出";
            phase = "ready";
            phaseDetail = "速度合规，准备输出";
        }
    } else if (result.state.mode === "gps_blocked") {
        nextAction = "恢复可靠定位后重新判断";
        phase = "paused";
        phaseDetail = "定位数据不可用";
    } else if (result.state.mode === "session_complete") {
        nextAction = "返回列表后可重新开始";
        phase = "stopped";
        phaseDetail = "本局时间结束";
    }
    setText("lightning-next-action", nextAction);
    setGamePhase(phase, phaseDetail);
}

function runLightningLoop() {
    if (activeGame !== "lightning" || !lightningState) return;
    const now = Date.now();
    const cfg = gameSettings.lightning;
    const result = advanceLightningState(lightningState, cfg, latestLocationSample, now);
    const modeChanged = lightningLastMode && lightningLastMode !== result.state.mode;
    lightningState = result.state;
    sendLightningSafetySample(result, now);

    if (lightningOutputPending && now >= lightningCurrentOutputUntil) {
        lightningOutputPending = false;
        lightningCurrentOutputUntil = 0;
    }

    if (result.shouldStop) {
        if (result.state.mode === "gps_blocked") {
            setCapabilityState("location", "blocked", "GPS/GNSS 速度数据超过 3 秒未更新或质量不足；输出已停止。");
        }
        requestLightningStop(
            `lightning_${result.state.mode}`,
            result.state.mode === "overspeed"
                ? "速度达到 60 km/h，已请求立即停止 A/B 输出"
                : result.state.mode === "gps_blocked"
                    ? "定位数据中断或不可靠，已请求停止 A/B 输出"
                    : result.state.mode === "session_complete"
                        ? "本局时间结束，已请求停止 A/B 输出"
                        : "速度低于启动范围，已请求停止 A/B 输出"
        );
    }

    if (modeChanged && result.state.mode === "jam") {
        lightningJamBatchCount = 0;
        lightningJamBatchRestUntil = 0;
        lightningNextOutputAt = now + 500;
    }
    if (modeChanged && lightningLastMode === "jam" && result.state.mode !== "jam") {
        // 离开堵车后先记住切换来源；状态机会继续验证两秒稳定速度，真正进入行驶时
        // 再完整执行玩家设置的行驶休息，不能退化成写死的一秒。
        lightningResumeFromJam = true;
        lightningJamBatchCount = 0;
        lightningJamBatchRestUntil = 0;
    }
    if (modeChanged && result.state.mode === "driving" && lightningResumeFromJam) {
        lightningNextOutputAt = now + cfg.drivingRestSeconds * 1000;
        lightningResumeFromJam = false;
    }

    lightningLastMode = result.state.mode;
    updateLightningDashboard(result, cfg, now);

    if (result.state.mode !== "driving" && result.state.mode !== "jam") return;
    if (lightningOutputPending || now < lightningNextOutputAt) return;
    const blockReason = getOutputBlockReason();
    if (blockReason) {
        setGamePhase("blocked", `${blockReason}，雷电极速保持停止`);
        lightningNextOutputAt = now + 1000;
        return;
    }

    if (result.state.mode === "driving") {
        const strength = calculateLightningStrength(result.state.lastSpeedKmh, cfg);
        if (strength <= 0) return;
        const sent = sendLightningOutput("driving", strength, cfg.continuousSeconds, cfg.drivingRestSeconds);
        if (sent) setGamePhase("output", `行驶强度 ${strength}，本轮 ${cfg.continuousSeconds}s`);
        else setGamePhase("blocked", "后台通信不可用，未发送行驶输出");
        return;
    }

    if (now < lightningJamBatchRestUntil) return;
    if (lightningJamBatchCount >= cfg.jamBatchCount) {
        lightningJamBatchCount = 0;
        lightningJamBatchRestUntil = now + cfg.jamBatchRestSeconds * 1000;
        lightningNextOutputAt = lightningJamBatchRestUntil;
        setGamePhase("rest", "堵车模式完成一轮");
        return;
    }

    const sent = sendLightningOutput("jam", cfg.jamStrength, cfg.jamShockSeconds, 0);
    if (!sent) {
        setGamePhase("blocked", "后台通信不可用，未发送堵车输出");
        lightningNextOutputAt = now + 1000;
        return;
    }
    lightningJamBatchCount++;
    const randomGapSeconds = randomBetween(cfg.jamGapMinSeconds, cfg.jamGapMaxSeconds);
    lightningNextOutputAt = lightningCurrentOutputUntil + randomGapSeconds * 1000;
    setGamePhase("output", `堵车强度 ${cfg.jamStrength}，本次 ${cfg.jamShockSeconds}s`);
}

// --- 12. 初始化入口 ---

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
            if (control.id === "global-b-strength-percent") {
                populateGlobalOutputForm();
            } else if (selectedGame) {
                populateSettingsForm(selectedGame);
            }
        });
    });
}

window.onload = () => {
    populateGlobalOutputForm();
    populateSettingsForm("shake");
    populateSettingsForm("dice");
    populateSettingsForm("slot");
    populateSettingsForm("lightning");
    enhanceControlAccessibility();
    bindRovingTabKeyboard($("selection-tabs"), switchSelectionTab);
    switchSelectionTab(activeSelectionTab);
    inspectPassiveCapabilities();
    updateCapabilityPresentation();
    bindEmergencyStopEvents();
    updateGlobalSafetyStatus("正在连接电脑服务", false);
    connectWebSocket();
};
