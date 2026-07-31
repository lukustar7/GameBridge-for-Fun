(function () {
    "use strict";

    const protocol = window.CoyoteProtocol;
    const waveforms = window.LiteWaveforms;
    const rules = window.GameBridgeForFunLogic;
    const BleDriver = window.LiteBleDriver && window.LiteBleDriver.BleDriver;
    const OutputController = window.LiteOutputController && window.LiteOutputController.OutputController;
    const PwaManager = window.LitePwaManager && window.LitePwaManager.PwaManager;

    if (!protocol || !waveforms || !rules || !BleDriver || !OutputController || !PwaManager) {
        document.body.textContent = "Lite 运行文件不完整，请重新加载完整目录。";
        return;
    }

    const STORAGE_KEY = "gamebridge-lite-settings-v1";
    const SENSOR_MAX_AGE_MS = 1000;
    const LOCATION_MAX_AGE_MS = 3000;
    const SLOT_SYMBOLS = Object.freeze(["7️⃣", "🍀", "⭐", "💎", "🔔", "🍒"]);

    const DEFAULT_SETTINGS = Object.freeze({
        shake: Object.freeze({ safeAngle: 8, rampAngle: 25, maxStrength: 30 }),
        angle: Object.freeze({ tolerance: 8, rampDegrees: 25, maxStrength: 30 }),
        dice: Object.freeze({ baseStrength: 20, singleSeconds: 1, gapSeconds: 1, leopardMultiplier: 3, maxPunishCount: 36 }),
        slot: Object.freeze({
            winRate: "standard",
            missGain: 20,
            streakBonus: 5,
            smallWinDrop: 15,
            jackpotDrop: 40,
            lightStrength: 10,
            lightShockSeconds: 1,
            shockStrength: 30,
            shockSeconds: 2,
            sevenRule: "full",
            fullAfter: "reset"
        }),
        lightning: Object.freeze({
            startSpeed: 10,
            startStrength: 20,
            maxStrength: 80,
            fullSpeed: 50,
            continuousSeconds: 8,
            drivingRestSeconds: 3,
            overspeedRecoverySeconds: 5,
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
        shake: Object.freeze({ title: "手抖挑战", description: "以开始时的姿态为中心，偏离安全角度后按距离线性增加强度。" }),
        angle: Object.freeze({ title: "保持角度", description: "开始时自动校准目标姿态，超出容差后按偏离程度增加强度。" }),
        dice: Object.freeze({ title: "摇骰子对决", description: "双方各摇三颗骰子；输几点输出几下，豹子按点数乘倍率结算。" }),
        slot: Object.freeze({ title: "极速角子机", description: "三个图标同时开奖；未中奖会推高压力，满槽后按基础输出执行。" }),
        lightning: Object.freeze({ title: "雷电极速", description: "达到启动速度后按速度改变强度；低速、超速、定位异常和到时都会停止。" })
    });

    const SETTING_GROUPS = Object.freeze({
        shake: [
            { title: "基础", fields: [
                { key: "safeAngle", label: "安全角度", type: "range", min: 2, max: 25, step: 1, unit: "°" },
                { key: "rampAngle", label: "达到最大强度的偏离", type: "range", min: 10, max: 60, step: 1, unit: "°" },
                { key: "maxStrength", label: "玩法请求最大强度", type: "range", min: 0, max: 100, step: 1, unit: "" }
            ] }
        ],
        angle: [
            { title: "基础", fields: [
                { key: "tolerance", label: "允许偏离", type: "range", min: 2, max: 25, step: 1, unit: "°" },
                { key: "rampDegrees", label: "达到最大强度的偏离", type: "range", min: 10, max: 60, step: 1, unit: "°" },
                { key: "maxStrength", label: "玩法请求最大强度", type: "range", min: 0, max: 100, step: 1, unit: "" }
            ] }
        ],
        dice: [
            { title: "结算", fields: [
                { key: "baseStrength", label: "每下请求强度", type: "range", min: 0, max: 100, step: 1, unit: "" },
                { key: "singleSeconds", label: "每下时长", type: "range", min: 1, max: 30, step: 0.5, unit: " 秒" },
                { key: "gapSeconds", label: "每下间隔", type: "range", min: 0, max: 10, step: 0.5, unit: " 秒" },
                { key: "leopardMultiplier", label: "豹子倍率", type: "range", min: 1, max: 6, step: 1, unit: " 倍" },
                { key: "maxPunishCount", label: "单局最多执行", type: "range", min: 1, max: 36, step: 1, unit: " 下" }
            ] }
        ],
        slot: [
            { title: "基础输出", fields: [
                { key: "shockStrength", label: "满槽请求强度", type: "range", min: 0, max: 100, step: 1, unit: "" },
                { key: "shockSeconds", label: "满槽惩罚时长", type: "range", min: 1, max: 30, step: 0.5, unit: " 秒" },
                { key: "fullAfter", label: "惩罚后压力", type: "select", options: [["reset", "清空"], ["half", "降到 50%"], ["keep", "保持满槽"]] }
            ] },
            { title: "轻电规则", fields: [
                { key: "lightStrength", label: "没中奖轻电强度", type: "range", min: 0, max: 100, step: 1, unit: "" },
                { key: "lightShockSeconds", label: "没中奖轻电时长", type: "range", min: 1, max: 5, step: 0.5, unit: " 秒" },
                { key: "missGain", label: "没中奖压力增加", type: "range", min: 5, max: 50, step: 5, unit: "%" },
                { key: "streakBonus", label: "连续没中奖加成", type: "range", min: 0, max: 20, step: 1, unit: "%" }
            ] },
            { title: "中奖规则", fields: [
                { key: "winRate", label: "中奖倾向", type: "select", options: [["loose", "宽松"], ["standard", "标准"], ["brutal", "残酷"]] },
                { key: "smallWinDrop", label: "小奖降低压力", type: "range", min: 0, max: 50, step: 5, unit: "%" },
                { key: "jackpotDrop", label: "大奖降低压力", type: "range", min: 0, max: 100, step: 5, unit: "%" },
                { key: "sevenRule", label: "三个图标全是 7️⃣", type: "select", options: [["full", "进入满槽，本局不输出"], ["reset", "清空压力"], ["shock", "立即执行满槽惩罚"]] }
            ] }
        ],
        lightning: [
            { title: "基础", fields: [
                { key: "startSpeed", label: "启动速度", type: "range", min: 5, max: 20, step: 1, unit: " km/h" },
                { key: "startStrength", label: "启动请求强度", type: "range", min: 0, max: 100, step: 1, unit: "" },
                { key: "maxStrength", label: "玩法请求最大强度", type: "range", min: 0, max: 100, step: 1, unit: "" },
                { key: "fullSpeed", label: "达到最大强度的速度", type: "range", min: 15, max: 55, step: 1, unit: " km/h" },
                { key: "sessionMinutes", label: "单局时长", type: "range", min: 1, max: 30, step: 1, unit: " 分钟" }
            ] },
            { title: "行驶", fields: [
                { key: "continuousSeconds", label: "每轮连续输出", type: "range", min: 3, max: 30, step: 1, unit: " 秒" },
                { key: "drivingRestSeconds", label: "每轮强制休息", type: "range", min: 3, max: 30, step: 1, unit: " 秒" },
                { key: "overspeedRecoverySeconds", label: "超速恢复等待", type: "range", min: 0, max: 10, step: 1, unit: " 秒" }
            ] },
            { title: "堵车", fields: [
                { key: "jamEnabled", label: "启用“都是你的错”", type: "toggle" },
                { key: "jamEntrySeconds", label: "低速多久进入堵车", type: "range", min: 20, max: 120, step: 5, unit: " 秒" },
                { key: "jamStrength", label: "堵车请求强度", type: "range", min: 0, max: 100, step: 1, unit: "" },
                { key: "jamShockSeconds", label: "堵车单次输出", type: "range", min: 1, max: 20, step: 0.5, unit: " 秒" },
                { key: "jamGapMinSeconds", label: "随机间隔最短", type: "range", min: 10, max: 60, step: 1, unit: " 秒" },
                { key: "jamGapMaxSeconds", label: "随机间隔最长", type: "range", min: 15, max: 120, step: 1, unit: " 秒" },
                { key: "jamBatchCount", label: "每批最多触发", type: "range", min: 1, max: 10, step: 1, unit: " 次" },
                { key: "jamBatchRestSeconds", label: "每批强制休息", type: "range", min: 30, max: 180, step: 5, unit: " 秒" }
            ] }
        ]
    });

    const byId = (id) => document.getElementById(id);
    const elements = {
        tabs: Array.from(document.querySelectorAll(".task-tab")),
        pages: Array.from(document.querySelectorAll(".task-page")),
        taskTabs: document.querySelector(".task-tabs"),
        deviceStatus: byId("device-status"),
        protocolBadge: byId("protocol-badge"),
        connectionDetail: byId("connection-detail"),
        connectDevice: byId("connect-device"),
        emergencyStop: byId("emergency-stop"),
        retryCapabilities: byId("retry-capabilities"),
        capabilityBluetooth: byId("capability-bluetooth"),
        capabilityMotion: byId("capability-motion"),
        capabilityLocation: byId("capability-location"),
        capabilityOffline: byId("capability-offline"),
        waveformSelect: byId("waveform-select"),
        limitA: byId("limit-a"),
        limitB: byId("limit-b"),
        limitAValue: byId("limit-a-value"),
        limitBValue: byId("limit-b-value"),
        outputSummary: byId("output-summary"),
        outputConfirmCheckbox: byId("output-confirm-checkbox"),
        confirmOutput: byId("confirm-output"),
        confirmationStatus: byId("confirmation-status"),
        testOutput: byId("test-output"),
        gameListView: byId("game-list-view"),
        gameSettingsView: byId("game-settings-view"),
        settingsTitle: byId("settings-title"),
        settingsDescription: byId("settings-description"),
        settingsFields: byId("game-settings-fields"),
        settingsForm: byId("game-settings-form"),
        startGame: byId("start-game"),
        backToGames: byId("back-to-games"),
        playScreen: byId("play-screen"),
        playTitle: byId("play-title"),
        playStage: byId("play-stage"),
        playPrimary: byId("play-primary"),
        playSecondary: byId("play-secondary"),
        playMeter: byId("play-meter"),
        playMeterFill: document.querySelector("#play-meter span"),
        gameAction: byId("game-action"),
        endGame: byId("end-game"),
        safetyDialog: byId("lightning-safety-dialog"),
        safetyChecks: Array.from(document.querySelectorAll(".lightning-confirm")),
        confirmLightningSafety: byId("confirm-lightning-safety"),
        updateToast: byId("update-toast"),
        applyUpdate: byId("apply-update"),
        dismissUpdate: byId("dismiss-update"),
        checkUpdate: byId("check-update"),
        resetSettings: byId("reset-settings"),
        offlineDetail: byId("offline-detail"),
        messageToast: byId("message-toast")
    };

    let globalSettings = loadGlobalSettings();
    let gameSettings = loadGameSettings();
    let selectedGame = null;
    let activeSession = null;
    let sessionSequence = 0;
    let toastTimer = null;
    let wakeLock = null;

    const driver = new BleDriver({
        onStatus: handleDriverStatus,
        onActualStrength: function (actual) {
            if (activeSession) {
                elements.playSecondary.textContent = `设备回报 A ${actual.strengthA} · B ${actual.strengthB}`;
            }
        }
    });
    const output = new OutputController(driver, {
        onStateChange: function (state) {
            if (activeSession) {
                setStage(state.stage);
            }
        }
    });
    const pwa = new PwaManager();

    function cloneDefaults() {
        return Object.fromEntries(Object.entries(DEFAULT_SETTINGS).map(([key, value]) => [key, { ...value }]));
    }

    function readStoredObject() {
        try {
            const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
            return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
        } catch (_error) {
            return {};
        }
    }

    function loadGlobalSettings() {
        const candidate = readStoredObject().global || {};
        return {
            channel: protocol.normalizeChannel(candidate.channel),
            waveform: waveforms.normalizeKey(candidate.waveform),
            limitA: Math.round(rules.clamp(candidate.limitA ?? 30, 0, 200)),
            limitB: Math.round(rules.clamp(candidate.limitB ?? 30, 0, 200)),
            // 每次打开页面或重新连接都要求现场重新确认，不能沿用昨天的接线结论。
            confirmed: false
        };
    }

    function loadGameSettings() {
        const restored = rules.restoreSettings(cloneDefaults(), readStoredObject().games);
        return rules.applyStandaloneShockDurationFloor(restored);
    }

    function saveSettings() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                global: { ...globalSettings, confirmed: false },
                games: gameSettings
            }));
        } catch (_error) {
            showMessage("浏览器未允许保存设置；本次仍可继续使用。", "error");
        }
    }

    function showMessage(message, kind) {
        window.clearTimeout(toastTimer);
        elements.messageToast.textContent = message;
        elements.messageToast.dataset.kind = kind || "info";
        elements.messageToast.hidden = false;
        toastTimer = window.setTimeout(() => {
            elements.messageToast.hidden = true;
        }, 4200);
    }

    function setCapability(element, state, text) {
        element.dataset.state = state;
        element.textContent = text;
    }

    async function checkCapabilities(requestPermissions) {
        const bluetoothReady = window.isSecureContext && BleDriver.isSupported(navigator);
        setCapability(
            elements.capabilityBluetooth,
            bluetoothReady ? "ready" : "blocked",
            bluetoothReady ? "可用" : (window.isSecureContext ? "浏览器不支持" : "需要 HTTPS")
        );

        if (typeof DeviceOrientationEvent === "undefined") {
            setCapability(elements.capabilityMotion, "blocked", "设备不提供");
        } else {
            let motionText = "开始玩法时授权";
            let motionState = "pending";
            if (requestPermissions && typeof DeviceOrientationEvent.requestPermission === "function") {
                try {
                    const result = await DeviceOrientationEvent.requestPermission();
                    motionState = result === "granted" ? "ready" : "blocked";
                    motionText = result === "granted" ? "已授权" : "已拒绝";
                } catch (_error) {
                    motionState = "blocked";
                    motionText = "授权失败";
                }
            }
            setCapability(elements.capabilityMotion, motionState, motionText);
        }

        if (!navigator.geolocation) {
            setCapability(elements.capabilityLocation, "blocked", "没有 GPS/GNSS 接口");
        } else if (requestPermissions) {
            await new Promise((resolve) => {
                navigator.geolocation.getCurrentPosition(
                    (position) => {
                        const hasSpeed = Number.isFinite(position.coords.speed);
                        setCapability(elements.capabilityLocation, hasSpeed ? "ready" : "pending", hasSpeed ? "速度可用" : "已授权，速度待实测");
                        resolve();
                    },
                    (error) => {
                        setCapability(elements.capabilityLocation, "blocked", error.code === 1 ? "定位已拒绝" : "暂时无法定位");
                        resolve();
                    },
                    { enableHighAccuracy: true, timeout: 6000, maximumAge: 0 }
                );
            });
        } else {
            let permissionText = "进入玩法时检查";
            let permissionState = "pending";
            if (navigator.permissions && typeof navigator.permissions.query === "function") {
                try {
                    const result = await navigator.permissions.query({ name: "geolocation" });
                    if (result.state === "granted") {
                        permissionText = "已授权，速度待实测";
                        permissionState = "pending";
                    } else if (result.state === "denied") {
                        permissionText = "定位已拒绝";
                        permissionState = "blocked";
                    }
                } catch (_error) {
                    // 浏览器不支持统一权限查询时，保留“进入玩法时检查”。
                }
            }
            setCapability(elements.capabilityLocation, permissionState, permissionText);
        }
    }

    function handleDriverStatus(status) {
        const state = status && status.state;
        const message = status && status.message ? status.message : "蓝牙状态未知";
        elements.deviceStatus.textContent = message;
        elements.connectionDetail.textContent = message;
        if (state === "connected") {
            elements.deviceStatus.dataset.state = "on";
            elements.protocolBadge.textContent = `协议 ${status.protocol}`;
            elements.connectDevice.textContent = "更换连接设备";
            invalidateOutputConfirmation("设备已连接，请确认当前接线和上限。", false);
        } else if (state === "connecting") {
            elements.deviceStatus.dataset.state = "off";
            elements.protocolBadge.textContent = "识别中";
        } else {
            elements.deviceStatus.dataset.state = state === "error" ? "error" : "off";
            elements.protocolBadge.textContent = "未识别";
            elements.connectDevice.textContent = "选择并连接设备";
            invalidateOutputConfirmation("连接或修改设置后需要重新确认。", false);
            if (activeSession && state === "disconnected") {
                stopActiveSession("蓝牙连接断开", true).catch(function () {});
            }
        }
        updateReadyState();
    }

    function configureOutput() {
        output.configure(globalSettings);
        const channelLabel = globalSettings.channel === "a" ? "只用 A" : (globalSettings.channel === "b" ? "只用 B" : "A + B");
        const waveform = waveforms.listOptions().find((item) => item.key === globalSettings.waveform);
        elements.outputSummary.textContent = `${waveform ? waveform.label : "游戏默认"} · ${channelLabel}`;
    }

    function invalidateOutputConfirmation(message, persist) {
        globalSettings.confirmed = false;
        elements.outputConfirmCheckbox.checked = false;
        elements.confirmationStatus.textContent = message || "设置已变化，需要重新确认。";
        if (persist !== false) {
            saveSettings();
        }
        updateReadyState();
    }

    function readyForOutput() {
        return driver.connected && globalSettings.confirmed && rules.hasSafeOutputLimits(
            globalSettings.channel,
            globalSettings.limitA,
            globalSettings.limitB
        );
    }

    function updateReadyState() {
        const ready = readyForOutput();
        elements.testOutput.disabled = !ready || output.isRunning() || Boolean(activeSession);
        elements.startGame.disabled = !ready;
        elements.startGame.textContent = ready ? "开始游戏" : "连接并确认设置后开始";
    }

    function switchPage(pageName) {
        elements.tabs.forEach((tab) => {
            const selected = tab.dataset.page === pageName;
            tab.classList.toggle("is-active", selected);
            tab.setAttribute("aria-selected", String(selected));
        });
        elements.pages.forEach((page) => {
            page.hidden = page.id !== `page-${pageName}`;
        });
    }

    function createSettingControl(gameName, field) {
        if (field.type === "toggle") {
            const label = document.createElement("label");
            label.className = "toggle-field";
            const text = document.createElement("span");
            text.textContent = field.label;
            const input = document.createElement("input");
            input.type = "checkbox";
            input.checked = Boolean(gameSettings[gameName][field.key]);
            input.dataset.settingKey = field.key;
            label.append(text, input);
            return label;
        }

        const wrapper = document.createElement("div");
        wrapper.className = "setting-field";
        const label = document.createElement("label");
        const labelText = document.createElement("span");
        labelText.textContent = field.label;
        label.append(labelText);

        let input;
        if (field.type === "select") {
            input = document.createElement("select");
            input.className = "select-control";
            field.options.forEach(([value, text]) => {
                const option = document.createElement("option");
                option.value = value;
                option.textContent = text;
                input.append(option);
            });
            input.value = gameSettings[gameName][field.key];
        } else {
            const outputValue = document.createElement("output");
            outputValue.textContent = `${gameSettings[gameName][field.key]}${field.unit}`;
            label.append(outputValue);
            input = document.createElement("input");
            input.type = "range";
            input.min = String(field.min);
            input.max = String(field.max);
            input.step = String(field.step);
            input.value = String(gameSettings[gameName][field.key]);
            input.dataset.unit = field.unit;
            input.addEventListener("input", () => {
                outputValue.textContent = `${input.value}${field.unit}`;
            });
        }
        input.dataset.settingKey = field.key;
        label.htmlFor = `setting-${gameName}-${field.key}`;
        input.id = `setting-${gameName}-${field.key}`;
        wrapper.append(label, input);
        return wrapper;
    }

    function renderGameSettings(gameName) {
        selectedGame = gameName;
        elements.settingsTitle.textContent = GAME_META[gameName].title;
        elements.settingsDescription.textContent = GAME_META[gameName].description;
        elements.settingsFields.replaceChildren();
        SETTING_GROUPS[gameName].forEach((group, index) => {
            const details = document.createElement("details");
            details.className = "setting-group";
            details.open = index === 0 || SETTING_GROUPS[gameName].length === 1;
            const summary = document.createElement("summary");
            summary.textContent = group.title;
            const body = document.createElement("div");
            body.className = "setting-group-body";
            group.fields.forEach((field) => body.append(createSettingControl(gameName, field)));
            details.append(summary, body);
            elements.settingsFields.append(details);
        });
        elements.gameListView.hidden = true;
        elements.gameSettingsView.hidden = false;
        updateReadyState();
        // 玩法卡片可能位于长列表底部。先把焦点移出已隐藏的卡片，再于新布局完成后回顶，
        // 否则移动浏览器会为了保留旧焦点而自动恢复滚动位置，遮住“返回”入口。
        elements.backToGames.focus({ preventScroll: true });
        window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "auto" }));
        });
    }

    function updateGameSetting(event) {
        const input = event.target.closest("[data-setting-key]");
        if (!input || !selectedGame) {
            return;
        }
        const key = input.dataset.settingKey;
        if (input.type === "checkbox") {
            gameSettings[selectedGame][key] = input.checked;
        } else if (input.type === "range") {
            gameSettings[selectedGame][key] = Number(input.value);
        } else {
            gameSettings[selectedGame][key] = input.value;
        }
        saveSettings();
    }

    function setStage(stage) {
        elements.playStage.textContent = stage;
        elements.playStage.dataset.stage = stage;
    }

    function setPlayDisplay(primary, secondary, meterPercent) {
        elements.playPrimary.textContent = primary;
        elements.playSecondary.textContent = secondary;
        if (Number.isFinite(meterPercent)) {
            elements.playMeter.hidden = false;
            elements.playMeterFill.style.width = `${rules.clamp(meterPercent, 0, 100)}%`;
        } else {
            elements.playMeter.hidden = true;
        }
    }

    function createSession(type) {
        sessionSequence += 1;
        return {
            id: sessionSequence,
            type,
            timers: new Set(),
            intervals: new Set(),
            waits: new Map(),
            cleanups: [],
            busy: false
        };
    }

    function isSessionCurrent(session) {
        return Boolean(session && activeSession && session.id === activeSession.id);
    }

    function sessionDelay(session, milliseconds) {
        return new Promise((resolve) => {
            if (!isSessionCurrent(session)) {
                resolve(false);
                return;
            }
            const timer = window.setTimeout(() => {
                session.timers.delete(timer);
                session.waits.delete(timer);
                resolve(isSessionCurrent(session));
            }, milliseconds);
            session.timers.add(timer);
            session.waits.set(timer, resolve);
        });
    }

    function sessionTimeout(session, callback, milliseconds) {
        const timer = window.setTimeout(() => {
            session.timers.delete(timer);
            if (isSessionCurrent(session)) {
                callback();
            }
        }, milliseconds);
        session.timers.add(timer);
        return timer;
    }

    function clearSessionTimer(session, timer) {
        if (!timer) {
            return;
        }
        window.clearTimeout(timer);
        session.timers.delete(timer);
        const resolver = session.waits.get(timer);
        if (resolver) {
            session.waits.delete(timer);
            resolver(false);
        }
    }

    async function acquireWakeLock() {
        if (!navigator.wakeLock || typeof navigator.wakeLock.request !== "function") {
            return;
        }
        try {
            wakeLock = await navigator.wakeLock.request("screen");
        } catch (_error) {
            showMessage("浏览器未能保持屏幕常亮，请暂时关闭系统自动锁屏。", "error");
        }
    }

    async function releaseWakeLock() {
        if (!wakeLock) {
            return;
        }
        try {
            await wakeLock.release();
        } catch (_error) {
            // 锁屏时系统可能已自动释放，无需再次提示。
        }
        wakeLock = null;
    }

    async function launchGame(gameName) {
        if (!readyForOutput()) {
            showMessage("请先连接设备并确认全局输出设置。", "error");
            return;
        }
        if (activeSession) {
            await stopActiveSession("切换玩法", false);
        }
        await output.stop("开始玩法前归零");
        const session = createSession(gameName);
        activeSession = session;
        elements.taskTabs.hidden = true;
        elements.pages.forEach((page) => { page.hidden = true; });
        elements.playScreen.hidden = false;
        elements.playTitle.textContent = GAME_META[gameName].title;
        elements.gameAction.hidden = true;
        elements.gameAction.disabled = false;
        setStage("等待判定");
        setPlayDisplay("准备中", "正在建立本次独立游戏会话");
        updateReadyState();
        acquireWakeLock();

        try {
            if (gameName === "shake" || gameName === "angle") {
                await startOrientationGame(session);
            } else if (gameName === "dice") {
                startDiceGame(session);
            } else if (gameName === "slot") {
                startSlotGame(session);
            } else if (gameName === "lightning") {
                await startLightningGame(session);
            }
        } catch (error) {
            showMessage(error.message || "游戏启动失败", "error");
            await stopActiveSession("启动失败", true);
        }
    }

    async function stopActiveSession(reason, returnToSettings) {
        const session = activeSession;
        if (session) {
            activeSession = null;
            session.cleanups.forEach((cleanup) => {
                try { cleanup(); } catch (_error) {}
            });
            session.intervals.forEach((timer) => window.clearInterval(timer));
            session.timers.forEach((timer) => window.clearTimeout(timer));
            session.waits.forEach((resolve) => resolve(false));
            session.timers.clear();
            session.intervals.clear();
            session.waits.clear();
        }
        await output.emergencyStop(reason || "结束游戏");
        await releaseWakeLock();
        elements.playScreen.hidden = true;
        elements.taskTabs.hidden = false;
        if (returnToSettings !== false) {
            switchPage("games");
            elements.gameListView.hidden = !selectedGame;
            elements.gameSettingsView.hidden = !selectedGame;
        }
        updateReadyState();
    }

    async function requestOrientationPermission() {
        if (typeof DeviceOrientationEvent === "undefined") {
            throw new Error("当前设备没有动作与方向传感器接口");
        }
        if (typeof DeviceOrientationEvent.requestPermission === "function") {
            const result = await DeviceOrientationEvent.requestPermission();
            if (result !== "granted") {
                throw new Error("动作与方向权限被拒绝，请在浏览器设置中允许后重试");
            }
        }
    }

    async function startOrientationGame(session) {
        await requestOrientationPermission();
        if (!isSessionCurrent(session)) {
            return;
        }
        const cfg = gameSettings[session.type];
        let baseline = null;
        let lastSensorAt = Date.now();
        let sensorStopped = false;
        await output.startContinuous(0, GAME_META[session.type].title);

        const handleOrientation = (event) => {
            if (!isSessionCurrent(session) || sensorStopped) {
                return;
            }
            const beta = Number(event.beta);
            const gamma = Number(event.gamma);
            if (!Number.isFinite(beta) || !Number.isFinite(gamma)) {
                return;
            }
            lastSensorAt = Date.now();
            if (!baseline) {
                baseline = { beta, gamma };
                setPlayDisplay("已校准", "保持当前姿态，移动后开始判定", 0);
                return;
            }
            const deviation = Math.hypot(beta - baseline.beta, gamma - baseline.gamma);
            const threshold = session.type === "shake" ? cfg.safeAngle : cfg.tolerance;
            const ramp = session.type === "shake" ? cfg.rampAngle : cfg.rampDegrees;
            const ratio = rules.clamp((deviation - threshold) / Math.max(1, ramp - threshold), 0, 1);
            const strength = Math.round(cfg.maxStrength * ratio);
            output.updateContinuous(strength, GAME_META[session.type].title);
            setPlayDisplay(
                `${deviation.toFixed(1)}°`,
                strength > 0 ? `超出安全范围，请求强度 ${strength}` : "位于安全范围，保持停止",
                ratio * 100
            );
        };

        window.addEventListener("deviceorientation", handleOrientation, true);
        session.cleanups.push(() => window.removeEventListener("deviceorientation", handleOrientation, true));
        const watchdog = window.setInterval(() => {
            if (!isSessionCurrent(session) || sensorStopped) {
                return;
            }
            if (Date.now() - lastSensorAt > SENSOR_MAX_AGE_MS) {
                sensorStopped = true;
                output.emergencyStop("方向传感器超过 1 秒未更新");
                setStage("已暂停");
                setPlayDisplay("传感器已暂停", "结束游戏后检查权限并重新开始");
            }
        }, 250);
        session.intervals.add(watchdog);
        setPlayDisplay("等待传感器", "请保持手机在准备姿态", 0);
    }

    function randomDice() {
        return Array.from({ length: 3 }, () => 1 + Math.floor(Math.random() * 6));
    }

    function startDiceGame(session) {
        elements.gameAction.hidden = false;
        elements.gameAction.textContent = "摇骰子";
        setPlayDisplay("—  —  —", "点击摇骰子开始一局");
        elements.gameAction.onclick = () => runDiceRound(session);
    }

    async function runDiceRound(session) {
        if (!isSessionCurrent(session) || session.busy) {
            return;
        }
        session.busy = true;
        elements.gameAction.disabled = true;
        try {
            const cfg = gameSettings.dice;
            const player = randomDice();
            const opponent = randomDice();
            const result = rules.evaluateDiceRound(player, opponent, cfg.leopardMultiplier);
            const plan = rules.calculateDiceExecutionPlan(result.punishmentCount, cfg, 300);
            setPlayDisplay(
                `${player.join(" · ")}  /  ${opponent.join(" · ")}`,
                `${result.reason}；计划执行 ${plan.executionCount} 下`
            );
            if (plan.executionCount === 0) {
                setStage("等待判定");
                return;
            }
            for (let index = 0; index < plan.executionCount; index += 1) {
                if (!isSessionCurrent(session)) {
                    return;
                }
                setStage("输出中");
                elements.playSecondary.textContent = `${result.reason}；第 ${index + 1} / ${plan.executionCount} 下`;
                await output.playPulse(cfg.baseStrength, plan.singleSeconds * 1000, "骰子结算");
                if (index < plan.executionCount - 1 && isSessionCurrent(session)) {
                    setStage("间隔中");
                    elements.playSecondary.textContent = "本轮间隔中，下一下尚未开始";
                    const continued = await sessionDelay(session, cfg.gapSeconds * 1000);
                    if (!continued) {
                        return;
                    }
                }
            }
            setStage("等待判定");
            elements.playSecondary.textContent = "本局结算完成，可以再次摇骰子";
        } catch (error) {
            showMessage(error.message || "骰子结算失败", "error");
            await output.emergencyStop("骰子结算异常");
        } finally {
            if (isSessionCurrent(session)) {
                session.busy = false;
                elements.gameAction.disabled = false;
            }
        }
    }

    function startSlotGame(session) {
        session.slotState = { pressure: 0, missStreak: 0 };
        elements.gameAction.hidden = false;
        elements.gameAction.textContent = "开始摇奖";
        setPlayDisplay("？  ？  ？", "压力 0%，点击开始摇奖", 0);
        elements.gameAction.onclick = () => runSlotRound(session);
    }

    async function runSlotRound(session) {
        if (!isSessionCurrent(session) || session.busy) {
            return;
        }
        session.busy = true;
        elements.gameAction.disabled = true;
        try {
            const cfg = gameSettings.slot;
            const reels = rules.buildSlotResult(cfg, SLOT_SYMBOLS, Math.random);
            const resultType = rules.classifySlotResult(reels);
            session.slotState = rules.advanceSlotState(session.slotState, cfg, resultType);
            setPlayDisplay(
                reels.join("  "),
                `${session.slotState.message}；当前压力 ${session.slotState.pressure}%`,
                session.slotState.pressure
            );

            if (session.slotState.triggerPunishment) {
                setStage("输出中");
                await output.playPulse(cfg.shockStrength, cfg.shockSeconds * 1000, session.slotState.punishmentReason);
                if (cfg.fullAfter === "reset") {
                    session.slotState.pressure = 0;
                } else if (cfg.fullAfter === "half") {
                    session.slotState.pressure = 50;
                }
                elements.playSecondary.textContent = `满槽惩罚完成；当前压力 ${session.slotState.pressure}%`;
                elements.playMeterFill.style.width = `${session.slotState.pressure}%`;
            } else if (resultType === "miss" && cfg.lightStrength > 0) {
                setStage("输出中");
                await output.playPulse(cfg.lightStrength, cfg.lightShockSeconds * 1000, "没中奖轻电");
                elements.playSecondary.textContent = `${session.slotState.message}；轻电完成`;
            }
            setStage("等待判定");
        } catch (error) {
            showMessage(error.message || "角子机结算失败", "error");
            await output.emergencyStop("角子机结算异常");
        } finally {
            if (isSessionCurrent(session)) {
                session.busy = false;
                elements.gameAction.disabled = false;
            }
        }
    }

    function lightningModeText(mode) {
        const labels = {
            waiting_speed: "等待达到启动速度",
            driving: "行驶规则",
            low_pending: "低速确认中",
            low_paused: "低速暂停",
            jam: "堵车模式",
            overspeed: "超速暂停",
            gps_blocked: "定位异常",
            session_complete: "本局已结束"
        };
        return labels[mode] || "等待判定";
    }

    async function startLightningGame(session) {
        if (!navigator.geolocation) {
            throw new Error("当前设备没有 GPS/GNSS 定位接口，不能使用雷电极速");
        }
        session.lightningSettings = rules.normalizeLightningSettings(gameSettings.lightning, DEFAULT_SETTINGS.lightning);
        session.lightningState = rules.createLightningState(Date.now());
        session.lastLocationSample = { valid: false, speedKmh: null, timestamp: Date.now() };
        session.lastMode = null;
        session.driveCycleStartedAt = null;
        session.driveRestUntil = 0;
        session.jamTimer = null;
        session.jamBusy = false;
        session.jamCount = 0;
        session.lightningQueue = Promise.resolve();
        await output.startContinuous(0, "雷电极速等待速度");

        const watchId = navigator.geolocation.watchPosition(
            (position) => {
                if (!isSessionCurrent(session)) {
                    return;
                }
                const speedMps = Number(position.coords.speed);
                const accuracy = Number(position.coords.accuracy);
                session.lastLocationSample = {
                    valid: Number.isFinite(speedMps) && speedMps >= 0 && Number.isFinite(accuracy) && accuracy <= 100,
                    speedKmh: Number.isFinite(speedMps) ? speedMps * 3.6 : null,
                    timestamp: Date.now()
                };
                queueLightningTick(session);
            },
            (error) => {
                if (!isSessionCurrent(session)) {
                    return;
                }
                session.lastLocationSample = { valid: false, speedKmh: null, timestamp: Date.now() };
                setCapability(elements.capabilityLocation, "blocked", error.code === 1 ? "定位已拒绝" : "GPS/GNSS 暂不可用");
                queueLightningTick(session);
            },
            { enableHighAccuracy: true, maximumAge: 0, timeout: 5000 }
        );
        session.cleanups.push(() => navigator.geolocation.clearWatch(watchId));
        const ticker = window.setInterval(() => queueLightningTick(session), 500);
        session.intervals.add(ticker);
        setPlayDisplay("0.0 km/h", "等待达到启动速度并稳定 2 秒", 0);
    }

    function queueLightningTick(session) {
        session.lightningQueue = session.lightningQueue
            .catch(function () {})
            .then(() => processLightningTick(session))
            .catch((error) => {
                if (isSessionCurrent(session)) {
                    showMessage(error.message || "速度规则处理失败", "error");
                    output.emergencyStop("速度规则异常");
                }
            });
    }

    async function processLightningTick(session) {
        if (!isSessionCurrent(session)) {
            return;
        }
        const now = Date.now();
        const sample = {
            ...session.lastLocationSample,
            valid: session.lastLocationSample.valid && now - session.lastLocationSample.timestamp < LOCATION_MAX_AGE_MS
        };
        const result = rules.advanceLightningState(
            session.lightningState,
            session.lightningSettings,
            sample,
            now
        );
        session.lightningState = result.state;
        const speed = Number(sample.speedKmh);
        const speedText = Number.isFinite(speed) ? `${speed.toFixed(1)} km/h` : "速度无效";
        const mode = result.state.mode;

        if (mode === "jam") {
            session.driveCycleStartedAt = null;
            session.driveRestUntil = 0;
            setPlayDisplay(speedText, "堵车模式已进入，按随机间隔执行", Number.isFinite(speed) ? speed / 0.6 : 0);
            setStage(session.jamBusy ? "输出中" : "间隔中");
            startJamSchedule(session);
        } else {
            const wasJam = session.lastMode === "jam" || session.jamBusy || session.jamTimer;
            cancelJamSchedule(session);
            if (wasJam) {
                await output.stop("离开堵车规则");
            }

            if (mode === "driving") {
                if (now < session.driveRestUntil) {
                    await ensureLightningContinuous(session, 0);
                    setStage("休息中");
                    setPlayDisplay(speedText, "行驶强制休息中，当前保持停止", speed / 0.6);
                } else {
                    if (session.driveCycleStartedAt === null) {
                        session.driveCycleStartedAt = now;
                    }
                    const elapsed = now - session.driveCycleStartedAt;
                    if (elapsed >= session.lightningSettings.continuousSeconds * 1000) {
                        session.driveCycleStartedAt = null;
                        session.driveRestUntil = now + session.lightningSettings.drivingRestSeconds * 1000;
                        await ensureLightningContinuous(session, 0);
                        setStage("休息中");
                        setPlayDisplay(speedText, "本轮输出完成，进入强制休息", speed / 0.6);
                    } else {
                        await ensureLightningContinuous(session, result.strength);
                        setStage("输出中");
                        setPlayDisplay(speedText, `行驶规则，请求强度 ${result.strength}`, speed / 0.6);
                    }
                }
            } else {
                session.driveCycleStartedAt = null;
                session.driveRestUntil = 0;
                if (result.shouldStop || output.isRunning()) {
                    await output.stop(lightningModeText(mode));
                }
                setStage(mode === "session_complete" ? "已停止" : "已暂停");
                setPlayDisplay(speedText, lightningModeText(mode), Number.isFinite(speed) ? speed / 0.6 : 0);
            }
        }
        session.lastMode = mode;
    }

    async function ensureLightningContinuous(session, strength) {
        if (!isSessionCurrent(session)) {
            return;
        }
        if (output.isRunning()) {
            output.updateContinuous(strength, "雷电极速行驶规则");
            return;
        }
        await output.startContinuous(strength, "雷电极速行驶规则");
    }

    function startJamSchedule(session) {
        if (!isSessionCurrent(session) || session.jamBusy || session.jamTimer) {
            return;
        }
        const delayMs = session.jamCount === 0 ? 0 : randomJamGap(session.lightningSettings);
        session.jamTimer = sessionTimeout(session, () => runJamPulse(session), delayMs);
    }

    function randomJamGap(settings) {
        const minimum = settings.jamGapMinSeconds;
        const maximum = Math.max(minimum, settings.jamGapMaxSeconds);
        return (minimum + Math.random() * (maximum - minimum)) * 1000;
    }

    async function runJamPulse(session) {
        session.jamTimer = null;
        if (!isSessionCurrent(session) || session.lightningState.mode !== "jam") {
            return;
        }
        session.jamBusy = true;
        setStage("输出中");
        try {
            await output.playPulse(
                session.lightningSettings.jamStrength,
                session.lightningSettings.jamShockSeconds * 1000,
                "堵车随机输出"
            );
        } catch (error) {
            if (isSessionCurrent(session)) {
                showMessage(error.message || "堵车输出失败", "error");
            }
        }
        if (!isSessionCurrent(session) || session.lightningState.mode !== "jam") {
            return;
        }
        session.jamBusy = false;
        session.jamCount += 1;
        if (session.jamCount >= session.lightningSettings.jamBatchCount) {
            session.jamCount = 0;
            setStage("休息中");
            elements.playSecondary.textContent = "本批触发完成，进入堵车强制休息";
            session.jamTimer = sessionTimeout(
                session,
                () => {
                    session.jamTimer = null;
                    startJamSchedule(session);
                },
                session.lightningSettings.jamBatchRestSeconds * 1000
            );
        } else {
            setStage("间隔中");
            elements.playSecondary.textContent = "堵车随机间隔中";
            startJamSchedule(session);
        }
    }

    function cancelJamSchedule(session) {
        if (session.jamTimer) {
            clearSessionTimer(session, session.jamTimer);
            session.jamTimer = null;
        }
        session.jamBusy = false;
        session.jamCount = 0;
    }

    function applyInitialSettingsToUi() {
        waveforms.listOptions().forEach((item) => {
            const option = document.createElement("option");
            option.value = item.key;
            option.textContent = item.label;
            elements.waveformSelect.append(option);
        });
        elements.waveformSelect.value = globalSettings.waveform;
        elements.limitA.value = String(globalSettings.limitA);
        elements.limitB.value = String(globalSettings.limitB);
        elements.limitAValue.textContent = String(globalSettings.limitA);
        elements.limitBValue.textContent = String(globalSettings.limitB);
        const channel = document.querySelector(`input[name="output-channel"][value="${globalSettings.channel}"]`);
        if (channel) {
            channel.checked = true;
        }
        configureOutput();
    }

    function bindEvents() {
        elements.tabs.forEach((tab) => tab.addEventListener("click", () => switchPage(tab.dataset.page)));
        elements.connectDevice.addEventListener("click", async () => {
            elements.connectDevice.disabled = true;
            try {
                await driver.connect(navigator);
            } catch (error) {
                showMessage(error.message || "设备连接失败", "error");
            } finally {
                elements.connectDevice.disabled = false;
                updateReadyState();
            }
        });
        elements.retryCapabilities.addEventListener("click", () => checkCapabilities(true));

        document.querySelectorAll("input[name='output-channel']").forEach((input) => {
            input.addEventListener("change", () => {
                globalSettings.channel = input.value;
                configureOutput();
                invalidateOutputConfirmation("通道已变化，需要重新确认接线。", true);
            });
        });
        elements.waveformSelect.addEventListener("change", () => {
            globalSettings.waveform = waveforms.normalizeKey(elements.waveformSelect.value);
            configureOutput();
            invalidateOutputConfirmation("波形已变化，需要重新确认。", true);
        });
        [elements.limitA, elements.limitB].forEach((input) => {
            input.addEventListener("input", () => {
                globalSettings.limitA = Number(elements.limitA.value);
                globalSettings.limitB = Number(elements.limitB.value);
                elements.limitAValue.textContent = elements.limitA.value;
                elements.limitBValue.textContent = elements.limitB.value;
                configureOutput();
                invalidateOutputConfirmation("网页上限已变化，需要重新确认。", true);
            });
        });
        elements.confirmOutput.addEventListener("click", () => {
            if (!driver.connected) {
                showMessage("请先连接设备。", "error");
                return;
            }
            if (!elements.outputConfirmCheckbox.checked) {
                showMessage("请先勾选接线与硬件限幅确认。", "error");
                return;
            }
            if (!rules.hasSafeOutputLimits(globalSettings.channel, globalSettings.limitA, globalSettings.limitB)) {
                showMessage("所选通道的网页上限必须大于 0。", "error");
                return;
            }
            globalSettings.confirmed = true;
            elements.confirmationStatus.textContent = "当前连接、通道和上限已确认。";
            configureOutput();
            updateReadyState();
        });
        elements.testOutput.addEventListener("click", async () => {
            if (!readyForOutput()) {
                return;
            }
            elements.testOutput.disabled = true;
            try {
                await output.playPulse(15, 1000, "低强度试电");
                showMessage("1 秒低强度试电完成。", "info");
            } catch (error) {
                showMessage(error.message || "试电失败", "error");
                await output.emergencyStop("试电异常");
            } finally {
                updateReadyState();
            }
        });

        document.querySelectorAll(".game-card").forEach((card) => {
            card.addEventListener("click", () => renderGameSettings(card.dataset.game));
        });
        elements.backToGames.addEventListener("click", () => {
            selectedGame = null;
            elements.gameSettingsView.hidden = true;
            elements.gameListView.hidden = false;
        });
        elements.settingsFields.addEventListener("input", updateGameSetting);
        elements.settingsFields.addEventListener("change", updateGameSetting);
        elements.settingsForm.addEventListener("submit", async (event) => {
            event.preventDefault();
            if (!selectedGame || !readyForOutput()) {
                showMessage("请先完成设备连接和全局输出确认。", "error");
                return;
            }
            if (selectedGame === "lightning") {
                elements.safetyChecks.forEach((checkbox) => { checkbox.checked = false; });
                elements.confirmLightningSafety.disabled = true;
                elements.safetyDialog.showModal();
                return;
            }
            await launchGame(selectedGame);
        });
        elements.safetyChecks.forEach((checkbox) => checkbox.addEventListener("change", () => {
            elements.confirmLightningSafety.disabled = !elements.safetyChecks.every((item) => item.checked);
        }));
        elements.safetyDialog.addEventListener("close", () => {
            if (elements.safetyDialog.returnValue === "default" && elements.safetyChecks.every((item) => item.checked)) {
                launchGame("lightning");
            }
        });
        elements.endGame.addEventListener("click", () => stopActiveSession("用户结束游戏", true));
        elements.emergencyStop.addEventListener("click", async () => {
            if (activeSession) {
                await stopActiveSession("用户按下立即停止", true);
            } else {
                await output.emergencyStop("用户按下立即停止");
            }
            showMessage("停止请求已执行，仍请确认硬件侧输出已归零。", "info");
        });

        elements.dismissUpdate.addEventListener("click", () => { elements.updateToast.hidden = true; });
        elements.applyUpdate.addEventListener("click", () => {
            const safe = !activeSession && !output.isRunning();
            if (!pwa.applyUpdate(safe)) {
                showMessage("请先结束游戏并停止输出，再切换版本。", "error");
            }
        });
        elements.checkUpdate.addEventListener("click", async () => {
            try {
                const waiting = await pwa.checkForUpdate();
                showMessage(waiting ? "新版本已下载，可在停止输出后更新。" : "当前已是可取得的最新离线版本。", "info");
            } catch (_error) {
                showMessage("当前网络无法检查更新，已缓存版本仍可使用。", "error");
            }
        });
        elements.resetSettings.addEventListener("click", () => {
            try { localStorage.removeItem(STORAGE_KEY); } catch (_error) {}
            window.location.reload();
        });

        document.addEventListener("visibilitychange", () => {
            if (document.hidden) {
                if (activeSession) {
                    stopActiveSession("页面进入后台", true).catch(function () {});
                } else {
                    output.emergencyStop("页面进入后台");
                }
            }
        });
        window.addEventListener("pagehide", () => {
            sessionSequence += 1;
            activeSession = null;
            output.emergencyStop("页面已离开");
        });
        window.addEventListener("error", () => output.emergencyStop("页面运行异常"));
        window.addEventListener("unhandledrejection", () => output.emergencyStop("未处理的运行异常"));
    }

    async function initPwa() {
        pwa.onUpdateFound(() => { elements.updateToast.hidden = false; });
        const status = await pwa.init();
        if (!status.supported) {
            setCapability(elements.capabilityOffline, "blocked", "需要 HTTPS");
            elements.offlineDetail.textContent = "当前环境不支持";
        } else if (status.controlled) {
            setCapability(elements.capabilityOffline, "ready", "已缓存");
            elements.offlineDetail.textContent = PwaManager.isInstalled() ? "已安装并缓存" : "已缓存，可离线启动";
        } else if (status.error) {
            setCapability(elements.capabilityOffline, "blocked", "缓存失败");
            elements.offlineDetail.textContent = "首次缓存失败";
        } else {
            setCapability(elements.capabilityOffline, "pending", "首次缓存中");
            elements.offlineDetail.textContent = "刷新一次后可离线";
        }
    }

    async function init() {
        applyInitialSettingsToUi();
        bindEvents();
        await checkCapabilities(false);
        await initPwa();
        updateReadyState();
    }

    init().catch((error) => {
        showMessage(error.message || "Lite 初始化失败", "error");
        output.emergencyStop("初始化异常");
    });
}());
