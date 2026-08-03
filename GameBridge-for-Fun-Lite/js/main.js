(function () {
    "use strict";

    const protocol = window.CoyoteProtocol;
    const waveforms = window.LiteWaveforms;
    const rules = window.GameBridgeForFunLogic;
    const gameConfig = window.LiteGameConfig;
    const gameRuntime = window.LiteGameRuntime;
    const BleDriver = window.LiteBleDriver && window.LiteBleDriver.BleDriver;
    const OutputController = window.LiteOutputController && window.LiteOutputController.OutputController;
    const PwaManager = window.LitePwaManager && window.LitePwaManager.PwaManager;

    if (!protocol || !waveforms || !rules || !gameConfig || !gameRuntime || !BleDriver || !OutputController || !PwaManager) {
        document.body.textContent = "Lite 运行文件不完整，请重新加载完整目录。";
        return;
    }

    const STORAGE_KEY = "gamebridge-lite-settings-v2";
    const LEGACY_STORAGE_KEY = "gamebridge-lite-settings-v1";
    const SENSOR_MAX_AGE_MS = 1000;
    const LOCATION_MAX_AGE_MS = 3000;
    const SLOT_SYMBOLS = Object.freeze(["7️⃣", "🍀", "⭐", "💎", "🔔", "🍒"]);

    const DEFAULT_OUTPUT_SETTINGS = gameConfig.DEFAULT_OUTPUT_SETTINGS;
    const DEFAULT_DEVICE_LIMITS = gameConfig.DEFAULT_DEVICE_LIMITS;
    const DEFAULT_SETTINGS = gameConfig.DEFAULT_SETTINGS;

    const GAME_META = gameConfig.GAME_META;
    const SETTING_CATEGORIES = gameConfig.SETTING_CATEGORIES;

    const SETTING_GROUPS = gameConfig.SETTING_GROUPS;

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
        capabilityWake: byId("capability-wake"),
        capabilityVibration: byId("capability-vibration"),
        waveformSelect: byId("waveform-select"),
        bStrengthMode: byId("b-strength-mode"),
        bStrengthPercent: byId("b-strength-percent"),
        bStrengthPercentValue: byId("b-strength-percent-value"),
        bChannelOptions: byId("b-channel-options"),
        bStrengthPercentBlock: byId("b-strength-percent-block"),
        limitA: byId("limit-a"),
        limitB: byId("limit-b"),
        limitAValue: byId("limit-a-value"),
        limitBValue: byId("limit-b-value"),
        outputSummary: byId("output-summary"),
        outputConfirmCheckbox: byId("output-confirm-checkbox"),
        outputConfirmRow: byId("output-confirm-row"),
        confirmOutput: byId("confirm-output"),
        editOutput: byId("edit-output"),
        outputLockBadge: byId("output-lock-badge"),
        confirmationStatus: byId("confirmation-status"),
        testOutputs: Array.from(document.querySelectorAll("[data-test-channel]")),
        gameListView: byId("game-list-view"),
        gameListTitle: byId("game-list-title"),
        gameSettingsView: byId("game-settings-view"),
        settingsTitle: byId("settings-title"),
        settingsDescription: byId("settings-description"),
        settingsFields: byId("game-settings-fields"),
        settingsForm: byId("game-settings-form"),
        restoreGameDefaults: byId("restore-game-defaults"),
        calibrateGamePose: byId("calibrate-game-pose"),
        settingsMessage: byId("settings-message"),
        startGame: byId("start-game"),
        backToGames: byId("back-to-games"),
        playScreen: byId("play-screen"),
        playTitle: byId("play-title"),
        playStage: byId("play-stage"),
        gameCanvas: byId("game-canvas"),
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
    const calibration = { shake: null };

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

    function readStoredObject() {
        try {
            const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.schemaVersion === 2) {
                return parsed;
            }
            const legacy = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || "null");
            if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
                // 旧版玩法字段含义不同，只迁移全局接线和网页上限；玩法恢复为已核对的原版默认值。
                return { global: legacy.global || {} };
            }
            return {};
        } catch (_error) {
            return {};
        }
    }

    function loadGlobalSettings() {
        const candidate = readStoredObject().global || {};
        const outputMode = protocol.normalizeChannel(candidate.outputMode || candidate.channel);
        const bStrengthMode = ["same", "percent"].includes(candidate.bStrengthMode)
            ? candidate.bStrengthMode
            : DEFAULT_OUTPUT_SETTINGS.bStrengthMode;
        return {
            outputMode,
            bStrengthMode,
            bStrengthPercent: Math.round(rules.clamp(
                candidate.bStrengthPercent ?? DEFAULT_OUTPUT_SETTINGS.bStrengthPercent,
                10,
                100
            )),
            waveform: waveforms.normalizeKey(candidate.waveform),
            limitA: Math.round(rules.clamp(candidate.limitA ?? DEFAULT_DEVICE_LIMITS.limitA, 0, 200)),
            limitB: Math.round(rules.clamp(candidate.limitB ?? DEFAULT_DEVICE_LIMITS.limitB, 0, 200)),
            // 每次打开页面或重新连接都要求现场重新确认，不能沿用昨天的接线结论。
            confirmed: false
        };
    }

    function loadGameSettings() {
        const normalized = gameConfig.normalizeSettings(readStoredObject().games);
        normalized.lightning = rules.normalizeLightningSettings(normalized.lightning, DEFAULT_SETTINGS.lightning);
        const restored = rules.applyStandaloneShockDurationFloor(normalized);
        return rules.clampGameStrengthSettings(restored, getEffectiveStrengthLimit());
    }

    function getEffectiveStrengthLimit() {
        return rules.getEffectiveBaseStrengthLimit(
            globalSettings.outputMode,
            globalSettings.limitA,
            globalSettings.limitB,
            globalSettings.bStrengthMode,
            globalSettings.bStrengthPercent
        );
    }

    function enforceGameStrengthLimit() {
        const limited = rules.clampGameStrengthSettings(gameSettings, getEffectiveStrengthLimit());
        const changed = JSON.stringify(limited) !== JSON.stringify(gameSettings);
        gameSettings = limited;
        return changed;
    }

    function isStrengthSetting(gameName, key) {
        const fields = {
            shake: ["strengthMin", "strengthMax"],
            dice: ["strength"],
            slot: ["strengthMin", "strengthMax"],
            lightning: ["startStrength", "maxStrength", "jamStrength"]
        };
        return fields[gameName]?.includes(key) || false;
    }

    function saveSettings() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                schemaVersion: 2,
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

    function verifyLocationSpeed() {
        return new Promise((resolve) => {
            let validSamples = 0;
            let firstValidAt = 0;
            let settled = false;
            let watchId = null;
            const finish = (ready, message) => {
                if (settled) return;
                settled = true;
                window.clearTimeout(timeout);
                if (watchId !== null) navigator.geolocation.clearWatch(watchId);
                setCapability(elements.capabilityLocation, ready ? "ready" : "blocked", message);
                resolve(ready);
            };
            const timeout = window.setTimeout(() => {
                finish(false, "未取得可靠 GPS/GNSS 速度");
            }, 8000);
            watchId = navigator.geolocation.watchPosition(
                (position) => {
                    const speed = Number(position.coords.speed);
                    const accuracy = Number(position.coords.accuracy);
                    const timestamp = Number(position.timestamp) || Date.now();
                    const valid = Number.isFinite(speed) && speed >= 0 &&
                        Number.isFinite(accuracy) && accuracy > 0 && accuracy <= 50 &&
                        Math.abs(Date.now() - timestamp) <= LOCATION_MAX_AGE_MS;
                    if (!valid) {
                        validSamples = 0;
                        firstValidAt = 0;
                        setCapability(elements.capabilityLocation, "pending", "已授权，正在等待可靠速度");
                        return;
                    }
                    if (validSamples === 0) firstValidAt = Date.now();
                    validSamples += 1;
                    if (validSamples >= 2 && Date.now() - firstValidAt >= 700) {
                        finish(true, `速度可用 · 精度约 ${Math.round(accuracy)} 米`);
                    } else {
                        setCapability(elements.capabilityLocation, "pending", "已收到速度，正在确认持续性");
                    }
                },
                (error) => finish(false, error.code === 1 ? "定位已拒绝" : "GPS/GNSS 暂不可用"),
                { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }
            );
        });
    }

    function verifyMotionData() {
        return new Promise((resolve) => {
            let orientationReady = false;
            let motionReady = false;
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                window.clearTimeout(timeout);
                window.removeEventListener("deviceorientation", handleOrientation, true);
                window.removeEventListener("devicemotion", handleMotion, true);
                if (orientationReady && motionReady) {
                    setCapability(elements.capabilityMotion, "ready", "方向与摇晃数据可用");
                } else if (orientationReady) {
                    setCapability(elements.capabilityMotion, "pending", "方向可用，摇晃数据未验证");
                } else if (motionReady) {
                    setCapability(elements.capabilityMotion, "pending", "摇晃可用，方向数据未验证");
                } else {
                    setCapability(elements.capabilityMotion, "blocked", "未收到传感器数据");
                }
                resolve(orientationReady || motionReady);
            };
            const handleOrientation = (event) => {
                orientationReady = Number.isFinite(Number(event.beta)) && Number.isFinite(Number(event.gamma));
                if (orientationReady && motionReady) finish();
            };
            const handleMotion = (event) => {
                motionReady = gameRuntime.motionForce(event) !== null;
                if (orientationReady && motionReady) finish();
            };
            const timeout = window.setTimeout(finish, 3500);
            window.addEventListener("deviceorientation", handleOrientation, true);
            window.addEventListener("devicemotion", handleMotion, true);
        });
    }

    async function checkCapabilities(requestPermissions) {
        const bluetoothReady = window.isSecureContext && BleDriver.isSupported(navigator);
        setCapability(
            elements.capabilityBluetooth,
            bluetoothReady ? "ready" : "blocked",
            bluetoothReady ? "可用" : (window.isSecureContext ? "浏览器不支持" : "需要 HTTPS")
        );

        setCapability(
            elements.capabilityWake,
            navigator.wakeLock && typeof navigator.wakeLock.request === "function" ? "ready" : "blocked",
            navigator.wakeLock && typeof navigator.wakeLock.request === "function" ? "可用" : "不支持，请手动防锁屏"
        );
        setCapability(
            elements.capabilityVibration,
            typeof navigator.vibrate === "function" ? "ready" : "blocked",
            typeof navigator.vibrate === "function" ? "可用" : "不支持，不影响输出"
        );

        if (typeof DeviceOrientationEvent === "undefined" && typeof DeviceMotionEvent === "undefined") {
            setCapability(elements.capabilityMotion, "blocked", "设备不提供");
        } else {
            let motionText = "开始相关玩法时授权";
            let motionState = "pending";
            if (requestPermissions) {
                try {
                    const requests = [];
                    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
                        requests.push(DeviceOrientationEvent.requestPermission());
                    }
                    if (typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function") {
                        requests.push(DeviceMotionEvent.requestPermission());
                    }
                    const results = await Promise.all(requests);
                    const granted = results.every((result) => result === "granted");
                    if (granted) {
                        setCapability(elements.capabilityMotion, "pending", "已授权，正在验证数据");
                        await verifyMotionData();
                        motionState = null;
                    } else {
                        motionState = "blocked";
                        motionText = "已拒绝";
                    }
                } catch (_error) {
                    motionState = "blocked";
                    motionText = "授权失败";
                }
            }
            if (motionState) setCapability(elements.capabilityMotion, motionState, motionText);
        }

        if (!navigator.geolocation) {
            setCapability(elements.capabilityLocation, "blocked", "没有 GPS/GNSS 接口");
        } else if (requestPermissions) {
            await verifyLocationSpeed();
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
        const channelLabel = globalSettings.outputMode === "a" ? "只用 A" : (globalSettings.outputMode === "b" ? "只用 B" : "A + B");
        const bLabel = globalSettings.bStrengthMode === "same"
            ? "B 同强度"
            : `B ${globalSettings.bStrengthPercent}%`;
        const waveform = waveforms.listOptions().find((item) => item.key === globalSettings.waveform);
        elements.outputSummary.textContent = `${waveform ? waveform.label : "游戏默认"} · ${channelLabel}${globalSettings.outputMode === "a" ? "" : ` · ${bLabel}`}`;
        elements.bChannelOptions.hidden = globalSettings.outputMode === "a";
        elements.bStrengthPercentBlock.hidden = globalSettings.bStrengthMode !== "percent";
    }

    function invalidateOutputConfirmation(message, persist) {
        globalSettings.confirmed = false;
        elements.outputConfirmCheckbox.checked = false;
        elements.confirmationStatus.textContent = message || "设置已变化，需要重新确认。";
        setOutputLockPresentation();
        if (persist !== false) {
            saveSettings();
        }
        updateReadyState();
    }

    function getOutputSettingControls() {
        return [
            ...document.querySelectorAll("input[name='output-channel']"),
            elements.bStrengthMode,
            elements.bStrengthPercent,
            elements.waveformSelect,
            elements.limitA,
            elements.limitB
        ].filter(Boolean);
    }

    function setOutputLockPresentation() {
        const locked = globalSettings.confirmed;
        getOutputSettingControls().forEach((control) => {
            control.disabled = locked;
        });
        elements.outputConfirmRow.hidden = locked;
        elements.confirmOutput.hidden = locked;
        elements.editOutput.hidden = !locked;
        elements.outputLockBadge.dataset.state = locked ? "locked" : "unlocked";
        elements.outputLockBadge.textContent = locked ? "已保存 / 已锁定" : "未锁定";
    }

    function readyForOutput() {
        return driver.connected && globalSettings.confirmed && rules.hasSafeOutputLimits(
            globalSettings.outputMode,
            globalSettings.limitA,
            globalSettings.limitB
        );
    }

    function updateReadyState() {
        const ready = readyForOutput();
        elements.testOutputs.forEach((button) => {
            button.disabled = !ready || output.isRunning() || Boolean(activeSession);
        });
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
        const wrapper = document.createElement("div");
        wrapper.className = "setting-field";
        wrapper.dataset.settingField = field.key;
        if (field.visibleWhen) {
            wrapper.dataset.visibleKey = field.visibleWhen.key;
            wrapper.dataset.visibleEquals = String(field.visibleWhen.equals);
        }

        const help = document.createElement("p");
        help.className = "field-help";
        help.textContent = field.help;

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
            wrapper.append(label, help);
            return wrapper;
        }

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
            input.max = String(isStrengthSetting(gameName, field.key)
                ? Math.min(field.max, getEffectiveStrengthLimit())
                : field.max);
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
        wrapper.append(label, input, help);
        return wrapper;
    }

    function refreshConditionalSettingFields() {
        if (!selectedGame) {
            return;
        }
        elements.settingsFields.querySelectorAll("[data-visible-key]").forEach((field) => {
            field.hidden = String(gameSettings[selectedGame][field.dataset.visibleKey]) !== field.dataset.visibleEquals;
        });
        if (selectedGame === "lightning") {
            elements.settingsFields.querySelectorAll("[data-setting-field^='jam']").forEach((field) => {
                if (field.dataset.settingField !== "jamEnabled") {
                    field.hidden = !gameSettings.lightning.jamEnabled;
                }
            });
        }
    }

    function syncVisibleSettingControls() {
        if (!selectedGame) return;
        elements.settingsFields.querySelectorAll("[data-setting-key]").forEach((input) => {
            const value = gameSettings[selectedGame][input.dataset.settingKey];
            if (input.type === "checkbox") input.checked = Boolean(value);
            else input.value = String(value);
            if (input.type === "range") {
                const valueLabel = input.closest(".setting-field")?.querySelector("output");
                if (valueLabel) valueLabel.textContent = `${value}${input.dataset.unit || ""}`;
            }
        });
    }

    function switchSettingsCategory(categoryIndex, focusTab) {
        const tabs = Array.from(elements.settingsFields.querySelectorAll("[role='tab']"));
        const panels = Array.from(elements.settingsFields.querySelectorAll("[role='tabpanel']"));
        tabs.forEach((tab, index) => {
            const selected = index === categoryIndex;
            tab.setAttribute("aria-selected", String(selected));
            tab.tabIndex = selected ? 0 : -1;
            if (selected && focusTab) {
                tab.focus();
            }
        });
        panels.forEach((panel, index) => {
            panel.hidden = index !== categoryIndex;
        });
    }

    function createSettingsTabs(gameName) {
        const categories = SETTING_CATEGORIES[gameName];
        const tabList = document.createElement("div");
        tabList.className = "setting-category-tabs";
        tabList.setAttribute("role", "tablist");
        tabList.setAttribute("aria-label", `${GAME_META[gameName].title}设置分类`);

        categories.forEach((category, categoryIndex) => {
            const tab = document.createElement("button");
            tab.type = "button";
            tab.id = `setting-tab-${gameName}-${categoryIndex}`;
            tab.setAttribute("role", "tab");
            tab.setAttribute("aria-controls", `setting-panel-${gameName}-${categoryIndex}`);
            tab.textContent = category.label;
            tab.addEventListener("click", () => switchSettingsCategory(categoryIndex, false));
            tab.addEventListener("keydown", (event) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
                    return;
                }
                event.preventDefault();
                let targetIndex = categoryIndex;
                if (event.key === "ArrowLeft") targetIndex = (categoryIndex - 1 + categories.length) % categories.length;
                if (event.key === "ArrowRight") targetIndex = (categoryIndex + 1) % categories.length;
                if (event.key === "Home") targetIndex = 0;
                if (event.key === "End") targetIndex = categories.length - 1;
                switchSettingsCategory(targetIndex, true);
            });
            tabList.append(tab);
        });
        elements.settingsFields.append(tabList);

        categories.forEach((category, categoryIndex) => {
            const panel = document.createElement("div");
            panel.id = `setting-panel-${gameName}-${categoryIndex}`;
            panel.className = "setting-category-panel";
            panel.setAttribute("role", "tabpanel");
            panel.setAttribute("aria-labelledby", `setting-tab-${gameName}-${categoryIndex}`);
            category.groups.forEach((groupIndex) => {
                const group = SETTING_GROUPS[gameName][groupIndex];
                const section = document.createElement("section");
                section.className = "setting-group";
                const heading = document.createElement("h3");
                heading.textContent = group.title;
                const body = document.createElement("div");
                body.className = "setting-group-body";
                group.fields.forEach((field) => body.append(createSettingControl(gameName, field)));
                section.append(heading, body);
                panel.append(section);
            });
            elements.settingsFields.append(panel);
        });
        switchSettingsCategory(0, false);
    }

    function renderGameSettings(gameName) {
        selectedGame = gameName;
        enforceGameStrengthLimit();
        elements.settingsTitle.textContent = GAME_META[gameName].title;
        elements.settingsDescription.textContent = GAME_META[gameName].description;
        elements.settingsFields.replaceChildren();
        createSettingsTabs(gameName);
        elements.calibrateGamePose.hidden = gameName !== "shake";
        elements.settingsMessage.textContent = "";
        refreshConditionalSettingFields();
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

    function showGameList() {
        selectedGame = null;
        elements.settingsFields.replaceChildren();
        elements.settingsTitle.textContent = "游戏设置";
        elements.settingsDescription.textContent = "";
        elements.settingsMessage.textContent = "";
        elements.gameSettingsView.hidden = true;
        elements.gameListView.hidden = false;
        elements.playScreen.hidden = true;
        elements.taskTabs.hidden = false;
        switchPage("games");
        if (!document.hidden) {
            elements.gameListTitle.focus({ preventScroll: true });
            window.requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "auto" }));
        }
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
        gameSettings = gameConfig.normalizeSettings(gameSettings);
        gameSettings.lightning = rules.normalizeLightningSettings(gameSettings.lightning, DEFAULT_SETTINGS.lightning);
        enforceGameStrengthLimit();
        syncVisibleSettingControls();
        refreshConditionalSettingFields();
        saveSettings();
    }

    function setStage(stage) {
        elements.playStage.textContent = stage;
        elements.playStage.dataset.stage = stage;
    }

    async function calibrateCurrentPose() {
        const gameName = selectedGame;
        if (gameName !== "shake") {
            return;
        }
        elements.calibrateGamePose.disabled = true;
        elements.settingsMessage.textContent = "正在读取当前姿态…";
        try {
            await requestOrientationPermission();
            const sample = await new Promise((resolve, reject) => {
                const timeout = window.setTimeout(() => {
                    window.removeEventListener("deviceorientation", handleSample, true);
                    reject(new Error("没有收到方向数据，请检查浏览器权限后重试"));
                }, 3000);
                function handleSample(event) {
                    const beta = Number(event.beta);
                    const gamma = Number(event.gamma);
                    if (!Number.isFinite(beta) || !Number.isFinite(gamma)) {
                        return;
                    }
                    window.clearTimeout(timeout);
                    window.removeEventListener("deviceorientation", handleSample, true);
                    resolve({ beta, gamma });
                }
                window.addEventListener("deviceorientation", handleSample, true);
            });
            calibration[gameName] = sample;
            elements.settingsMessage.textContent = "已使用当前握持姿态作为本次会话基准。";
        } catch (error) {
            elements.settingsMessage.textContent = error.message || "姿态校准失败，请检查权限后重试。";
        } finally {
            elements.calibrateGamePose.disabled = false;
        }
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
            if (gameName === "shake") {
                await startOrientationGame(session);
            } else if (gameName === "dice") {
                await startDiceGame(session);
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

    async function stopActiveSession(reason, returnToList) {
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
        if (returnToList !== false) {
            showGameList();
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

    async function requestMotionPermission() {
        if (typeof DeviceMotionEvent === "undefined") {
            throw new Error("当前设备没有动作传感器接口，无法使用摇晃开局");
        }
        if (typeof DeviceMotionEvent.requestPermission === "function") {
            const result = await DeviceMotionEvent.requestPermission();
            if (result !== "granted") {
                throw new Error("动作权限被拒绝，请在浏览器设置中允许后重试");
            }
        }
    }

    async function startOrientationGame(session) {
        await requestOrientationPermission();
        if (!isSessionCurrent(session)) {
            return;
        }
        const cfg = gameSettings[session.type];
        let baseline = calibration[session.type] ? { ...calibration[session.type] } : null;
        let latestOrientation = null;
        let lastSensorAt = Date.now();
        let sensorStopped = false;
        let outsideSince = null;
        let animationFrame = null;
        const canvas = elements.gameCanvas;
        const context = canvas.getContext("2d");
        const dpr = window.devicePixelRatio || 1;
        const width = Math.max(280, canvas.clientWidth || 320);
        const height = Math.max(240, canvas.clientHeight || 300);
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        context.setTransform(dpr, 0, 0, dpr, 0, 0);
        canvas.hidden = false;
        session.ball = { x: width / 2, y: height / 2, vx: 0, vy: 0, radius: 8 };
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
            latestOrientation = { beta, gamma };
            if (!baseline) {
                baseline = { beta, gamma };
                calibration[session.type] = { ...baseline };
                setPlayDisplay("已校准", "保持当前姿态，移动后开始判定", 0);
            }
        };

        window.addEventListener("deviceorientation", handleOrientation, true);
        session.cleanups.push(() => window.removeEventListener("deviceorientation", handleOrientation, true));
        session.cleanups.push(() => {
            if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
            canvas.hidden = true;
        });

        function drawBackground(dangerRatio) {
            context.fillStyle = "#02070e";
            context.fillRect(0, 0, width, height);
            context.strokeStyle = "#142235";
            context.lineWidth = 1;
            for (let x = 0; x <= width; x += 36) {
                context.beginPath();
                context.moveTo(x, 0);
                context.lineTo(x, height);
                context.stroke();
            }
            for (let y = 0; y <= height; y += 36) {
                context.beginPath();
                context.moveTo(0, y);
                context.lineTo(width, y);
                context.stroke();
            }
            if (dangerRatio > 0) {
                context.fillStyle = `rgba(255, 63, 74, ${0.05 + dangerRatio * 0.18})`;
                context.fillRect(0, 0, width, height);
            }
        }

        function applyDelayedOutput(error, dangerRatio, delayMs, safeText, checkingText) {
            if (error <= 0) {
                outsideSince = null;
                output.updateContinuous(0, GAME_META[session.type].title);
                setStage("等待判定");
                return { strength: 0, detail: safeText };
            }
            const now = Date.now();
            if (outsideSince === null) outsideSince = now;
            if (now - outsideSince < delayMs) {
                output.updateContinuous(0, GAME_META[session.type].title);
                setStage("持续判定中");
                return { strength: 0, detail: checkingText };
            }
            const strength = gameRuntime.interpolateStrength(cfg.strengthMin, cfg.strengthMax, dangerRatio);
            output.updateContinuous(strength, GAME_META[session.type].title);
            setStage("输出中");
            return { strength, detail: `持续偏离，请求强度 ${strength}` };
        }

        function drawShakeFrame() {
            const ball = session.ball;
            if (latestOrientation && baseline) {
                const relativeBeta = rules.clamp(latestOrientation.beta - baseline.beta, -45, 45);
                const relativeGamma = rules.clamp(latestOrientation.gamma - baseline.gamma, -45, 45);
                const sensitivity = cfg.sensitivity / 100;
                ball.vx += relativeGamma * 0.07 * sensitivity;
                ball.vy += relativeBeta * 0.07 * sensitivity;
            }
            ball.vx *= 0.982;
            ball.vy *= 0.982;
            ball.x += ball.vx;
            ball.y += ball.vy;
            if (ball.x - ball.radius < 0 || ball.x + ball.radius > width) {
                ball.x = rules.clamp(ball.x, ball.radius, width - ball.radius);
                ball.vx *= -0.5;
            }
            if (ball.y - ball.radius < 0 || ball.y + ball.radius > height) {
                ball.y = rules.clamp(ball.y, ball.radius, height - ball.radius);
                ball.vy *= -0.5;
            }
            const zone = gameRuntime.getShakeZoneState(ball, cfg, width, height);
            drawBackground(zone.dangerRatio);
            context.strokeStyle = zone.err > 0 ? "#ff3f4a" : "#59d7ff";
            context.lineWidth = 3;
            context.beginPath();
            if (cfg.mode === "gap") {
                context.arc(zone.centerX, zone.centerY, zone.inner, 0, Math.PI * 2);
                context.stroke();
                context.beginPath();
            }
            context.arc(zone.centerX, zone.centerY, zone.outer, 0, Math.PI * 2);
            context.stroke();
            context.fillStyle = zone.err > 0 ? "#ff3f4a" : "#ffffff";
            context.beginPath();
            context.arc(ball.x, ball.y, ball.radius, 0, Math.PI * 2);
            context.fill();
            const status = applyDelayedOutput(
                zone.err,
                zone.dangerRatio,
                cfg.forgiveMs,
                "弹珠在安全区内，当前保持停止",
                "弹珠已出界，正在持续判定"
            );
            setPlayDisplay(`${Math.round(zone.dangerRatio * 100)}%`, status.detail, zone.dangerRatio * 100);
        }

        function renderFrame() {
            if (!isSessionCurrent(session) || sensorStopped) return;
            drawShakeFrame();
            animationFrame = window.requestAnimationFrame(renderFrame);
        }
        animationFrame = window.requestAnimationFrame(renderFrame);

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
        return Array.from({ length: 3 }, () => gameRuntime.rollDie(Math.random));
    }

    function randomOpponentDice(difficulty) {
        return Array.from({ length: 3 }, () => gameRuntime.rollOpponentDie(difficulty, Math.random));
    }

    async function startDiceGame(session) {
        const cfg = gameSettings.dice;
        if (!cfg.manualRoll) {
            await requestMotionPermission();
        }
        elements.gameAction.hidden = !cfg.manualRoll;
        elements.gameAction.textContent = "手动摇骰子";
        setPlayDisplay("—  —  —", cfg.manualRoll ? "摇晃手机或点击按钮开始一局" : "摇晃手机开始一局");
        elements.gameAction.onclick = () => runDiceRound(session);
        let lastMotionTriggerAt = 0;
        const handleMotion = (event) => {
            if (!isSessionCurrent(session) || session.busy) return;
            const force = gameRuntime.motionForce(event);
            const now = Date.now();
            if (force !== null && force > cfg.shakeSensitivity && now - lastMotionTriggerAt > 1000) {
                lastMotionTriggerAt = now;
                runDiceRound(session);
            }
        };
        window.addEventListener("devicemotion", handleMotion, true);
        session.cleanups.push(() => window.removeEventListener("devicemotion", handleMotion, true));
    }

    async function runDiceRound(session) {
        if (!isSessionCurrent(session) || session.busy) {
            return;
        }
        session.busy = true;
        elements.gameAction.disabled = true;
        try {
            const cfg = gameSettings.dice;
            setStage("摇号中");
            for (let index = 0; index < 8; index += 1) {
                setPlayDisplay(`${randomDice().join(" · ")}  /  ${randomOpponentDice(cfg.opponentDifficulty).join(" · ")}`, "骰子正在滚动");
                if (navigator.vibrate) navigator.vibrate(25);
                const continued = await sessionDelay(session, 90);
                if (!continued) return;
            }
            const player = randomDice();
            const opponent = randomOpponentDice(cfg.opponentDifficulty);
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
                await output.playPulse(cfg.strength, plan.singleSeconds * 1000, "骰子结算");
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
                elements.gameAction.disabled = !gameSettings.dice.manualRoll;
            }
        }
    }

    function startSlotGame(session) {
        session.slotState = { pressure: 0, missStreak: 0 };
        elements.gameAction.hidden = false;
        elements.gameAction.textContent = gameSettings.slot.autoSpin ? "自动连转中" : "开始摇奖";
        setPlayDisplay("🍒  🔔  💎", gameSettings.slot.autoSpin ? "压力 0%，即将自动开转" : "压力 0%，点击开始摇奖", 0);
        elements.gameAction.onclick = () => runSlotRound(session);
        if (gameSettings.slot.autoSpin) {
            scheduleNextSlotRound(session, 600);
        }
    }

    function scheduleNextSlotRound(session, delayMs) {
        if (!isSessionCurrent(session) || !gameSettings.slot.autoSpin) return;
        session.busy = true;
        elements.gameAction.disabled = true;
        elements.gameAction.textContent = "间隔中";
        setStage("间隔中");
        elements.playSecondary.textContent = "自动连转间隔中，下一轮尚未开始";
        sessionTimeout(session, () => {
            session.busy = false;
            runSlotRound(session);
        }, delayMs);
    }

    async function runSlotRound(session) {
        if (!isSessionCurrent(session) || session.busy) {
            return;
        }
        session.busy = true;
        elements.gameAction.disabled = true;
        try {
            const cfg = gameSettings.slot;
            elements.gameAction.textContent = "开奖中";
            setStage("摇奖中");
            const spinDeadline = Date.now() + cfg.spinMs;
            while (Date.now() < spinDeadline) {
                setPlayDisplay(Array.from({ length: 3 }, () => SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)]).join("  "), "图标正在转动", session.slotState.pressure);
                const continued = await sessionDelay(session, Math.min(70, Math.max(1, spinDeadline - Date.now())));
                if (!continued) return;
            }
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
                const completed = await output.playPulse(cfg.strengthMax, cfg.shockSeconds * 1000, session.slotState.punishmentReason);
                if (completed) {
                    session.slotState.pressure = cfg.pressureAfterPunish === "keep" ? 100 : 0;
                    session.slotState.missStreak = 0;
                }
                elements.playSecondary.textContent = completed
                    ? `满槽惩罚完成；当前压力 ${session.slotState.pressure}%`
                    : "满槽惩罚未完成，压力保持不变";
                elements.playMeterFill.style.width = `${session.slotState.pressure}%`;
                if (completed) await runSlotRest(session, cfg.restMs);
            } else if (resultType === "miss" && cfg.lightPunishEnabled && cfg.strengthMin > 0) {
                setStage("输出中");
                const completed = await output.playPulse(cfg.strengthMin, cfg.lightShockSeconds * 1000, "没中奖轻电");
                elements.playSecondary.textContent = `${session.slotState.message}；轻电完成`;
                if (completed) await runSlotRest(session, cfg.restMs);
            }
            if (isSessionCurrent(session)) setStage("等待判定");
        } catch (error) {
            showMessage(error.message || "角子机结算失败", "error");
            await output.emergencyStop("角子机结算异常");
        } finally {
            if (isSessionCurrent(session)) {
                session.busy = false;
                if (gameSettings.slot.autoSpin) {
                    scheduleNextSlotRound(session, gameSettings.slot.autoIntervalMs);
                } else {
                    elements.gameAction.disabled = false;
                    elements.gameAction.textContent = "开始摇奖";
                }
            }
        }
    }

    async function runSlotRest(session, restMs) {
        if (!isSessionCurrent(session) || restMs <= 0) return;
        setStage("休息中");
        elements.playSecondary.textContent = "本轮输出完成，正在强制休息";
        await sessionDelay(session, restMs);
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
        session.resumeFromJam = false;
        session.lightningQueue = Promise.resolve();
        await output.startContinuous(0, "雷电极速等待速度");

        const watchId = navigator.geolocation.watchPosition(
            (position) => {
                if (!isSessionCurrent(session)) {
                    return;
                }
                const speedMps = Number(position.coords.speed);
                const accuracy = Number(position.coords.accuracy);
                const timestamp = Number(position.timestamp) || Date.now();
                session.lastLocationSample = {
                    valid: Number.isFinite(speedMps) && speedMps >= 0 &&
                        Number.isFinite(accuracy) && accuracy > 0 && accuracy <= 50 &&
                        Math.abs(Date.now() - timestamp) <= LOCATION_MAX_AGE_MS,
                    speedKmh: Number.isFinite(speedMps) ? speedMps * 3.6 : null,
                    timestamp
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
                session.resumeFromJam = true;
                await output.stop("离开堵车规则");
            }

            if (mode === "driving") {
                if (session.resumeFromJam) {
                    session.driveCycleStartedAt = null;
                    session.driveRestUntil = now + session.lightningSettings.drivingRestSeconds * 1000;
                    session.resumeFromJam = false;
                }
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
        const justEnteredJam = session.lastMode !== "jam" && session.jamCount === 0;
        const delayMs = justEnteredJam ? 500 : randomJamGap(session.lightningSettings);
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
        elements.bStrengthMode.value = globalSettings.bStrengthMode;
        elements.bStrengthPercent.value = String(globalSettings.bStrengthPercent);
        elements.bStrengthPercentValue.textContent = `${globalSettings.bStrengthPercent}%`;
        const channel = document.querySelector(`input[name="output-channel"][value="${globalSettings.outputMode}"]`);
        if (channel) {
            channel.checked = true;
        }
        configureOutput();
        setOutputLockPresentation();
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
                globalSettings.outputMode = protocol.normalizeChannel(input.value);
                configureOutput();
                invalidateOutputConfirmation("通道已变化，需要重新确认接线。", true);
            });
        });
        elements.bStrengthMode.addEventListener("change", () => {
            globalSettings.bStrengthMode = elements.bStrengthMode.value === "same" ? "same" : "percent";
            configureOutput();
            invalidateOutputConfirmation("B 通道强度规则已变化，需要重新确认。", true);
        });
        elements.bStrengthPercent.addEventListener("input", () => {
            globalSettings.bStrengthPercent = Number(elements.bStrengthPercent.value);
            elements.bStrengthPercentValue.textContent = `${elements.bStrengthPercent.value}%`;
            configureOutput();
            invalidateOutputConfirmation("B 通道强度比例已变化，需要重新确认。", true);
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
                showMessage("请先勾选接线与网页 A/B 安全上限确认。", "error");
                return;
            }
            if (!rules.hasSafeOutputLimits(globalSettings.outputMode, globalSettings.limitA, globalSettings.limitB)) {
                showMessage("所选通道的网页上限必须大于 0。", "error");
                return;
            }
            globalSettings.confirmed = true;
            enforceGameStrengthLimit();
            saveSettings();
            elements.confirmationStatus.textContent = `已保存并锁定；玩法请求强度不会超过 ${getEffectiveStrengthLimit()}。`;
            configureOutput();
            setOutputLockPresentation();
            updateReadyState();
        });
        elements.editOutput.addEventListener("click", async () => {
            await output.emergencyStop("修改全局输出设置");
            globalSettings.confirmed = false;
            elements.outputConfirmCheckbox.checked = false;
            elements.confirmationStatus.textContent = "设置已解锁。修改后请重新保存并锁定。";
            saveSettings();
            setOutputLockPresentation();
            getOutputSettingControls()[0]?.focus();
            updateReadyState();
        });
        elements.testOutputs.forEach((button) => button.addEventListener("click", async () => {
            if (!readyForOutput()) {
                return;
            }
            const testMode = protocol.normalizeChannel(button.dataset.testChannel);
            if (!rules.hasSafeOutputLimits(testMode, globalSettings.limitA, globalSettings.limitB)) {
                showMessage("该测试通道的网页上限必须大于 0。", "error");
                return;
            }
            elements.testOutputs.forEach((item) => { item.disabled = true; });
            try {
                output.configure({
                    ...globalSettings,
                    outputMode: testMode,
                    bStrengthMode: "same",
                    bStrengthPercent: 100,
                    waveform: "game_default"
                });
                await output.playPulse(15, 1000, "低强度试电");
                showMessage(`${testMode.toUpperCase()} 通道 1 秒低强度试电完成。`, "info");
            } catch (error) {
                showMessage(error.message || "试电失败", "error");
                await output.emergencyStop("试电异常");
            } finally {
                configureOutput();
                updateReadyState();
            }
        }));

        document.querySelectorAll(".game-card").forEach((card) => {
            card.addEventListener("click", () => renderGameSettings(card.dataset.game));
        });
        elements.backToGames.addEventListener("click", () => {
            showGameList();
        });
        elements.settingsFields.addEventListener("input", updateGameSetting);
        elements.settingsFields.addEventListener("change", updateGameSetting);
        elements.restoreGameDefaults.addEventListener("click", () => {
            if (!selectedGame) return;
            gameSettings[selectedGame] = { ...DEFAULT_SETTINGS[selectedGame] };
            enforceGameStrengthLimit();
            saveSettings();
            renderGameSettings(selectedGame);
            elements.settingsMessage.textContent = "已恢复当前玩法的原版默认设置。";
        });
        elements.calibrateGamePose.addEventListener("click", calibrateCurrentPose);
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
            showMessage("停止请求已执行，请直接确认设备输出已归零。", "info");
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
            try { localStorage.removeItem(LEGACY_STORAGE_KEY); } catch (_error) {}
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
