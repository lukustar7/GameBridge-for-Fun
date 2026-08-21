/* 电脑端控制台交互逻辑 console.js - 现代浅色仪表盘驱动 */

let ws = null;
let reconnectTimer = null;
const urlParams = new URLSearchParams(window.location.search);
const pinnedWsPort = parseInt(urlParams.get("ws"), 10);
const pinnedSecureWsPort = parseInt(urlParams.get("secureWs"), 10);
const hasPinnedWsPort = Number.isInteger(pinnedWsPort) && pinnedWsPort >= 1 && pinnedWsPort <= 65535;
const hasPinnedSecureWsPort = Number.isInteger(pinnedSecureWsPort) && pinnedSecureWsPort >= 1 && pinnedSecureWsPort <= 65535;
const isSecurePage = window.location.protocol === "https:";
let currentWsPort = isSecurePage
    ? (hasPinnedSecureWsPort ? pinnedSecureWsPort : 18444)
    : (hasPinnedWsPort ? pinnedWsPort : 18081); // 默认探测起点端口
const maxPortPortion = 10;  // 最大端口探测范围
let triedPortsCount = 0;

let appQR = null;
let gameQR = null;
let apkQR = null;
let certQR = null;
let certCerQR = null;
let secureGameQR = null;
let latestState = null;
let renderedDeviceSignature = "";
const renderedQrValues = new WeakMap();
const DEFAULT_TEST_STRENGTH = 15;

function setText(id, value) {
    const node = document.getElementById(id);
    if (node && node.innerText !== String(value)) {
        node.innerText = String(value);
    }
}

function setConnectionHint(message) {
    setText("game-url-text", message);
}

function setBackendStatus(mode, message) {
    const status = document.getElementById("backend-status");
    if (status) {
        status.classList.toggle("online", mode === "online");
        status.classList.toggle("offline", mode === "offline");
    }
    setText("backend-status-text", message);
}

/** 复制当前运行生成的地址 */
async function copyAddress(sourceId, resultId) {
    const source = document.getElementById(sourceId);
    const value = source?.innerText?.trim() || "";
    if (!value || value.startsWith("等待") || value.startsWith("正在")) {
        setText(resultId, "地址尚未生成，请稍等。");
        return;
    }

    try {
        await navigator.clipboard.writeText(value);
        setText(resultId, "已复制，可粘贴至手机。");
    } catch (error) {
        console.warn("复制地址失败:", error);
        setText(resultId, "请手动选中上方文本复制。");
    }
}

function renderQRCode(instance, text, targetName) {
    if (!instance || !text) return false;
    if (renderedQrValues.get(instance) === text) return true;

    try {
        instance.clear();
        instance.makeCode(text);
        renderedQrValues.set(instance, text);
        return true;
    } catch (error) {
        console.error(`${targetName}二维码生成失败:`, error);
        return false;
    }
}

function clearQRCode(instance) {
    if (!instance) return;
    instance.clear();
    renderedQrValues.delete(instance);
}

// 初始化二维码实例
function initQRCodes() {
    if (typeof QRCode === "undefined") {
        throw new Error("QRCode library is not loaded");
    }

    const qrConfig = {
        width: 170,
        height: 170,
        typeNumber: 12,
        colorDark: "#0F172A",
        colorLight: "#FFFFFF",
        correctLevel: QRCode.CorrectLevel.M
    };

    const appBox = document.getElementById("app-qrcode");
    const gameBox = document.getElementById("game-qrcode");
    const apkBox = document.getElementById("apk-qrcode");
    const certBox = document.getElementById("cert-qrcode");
    const certCerBox = document.getElementById("cert-cer-qrcode");
    const secureGameBox = document.getElementById("secure-game-qrcode");

    if (appBox) appQR = new QRCode(appBox, qrConfig);
    if (gameBox) gameQR = new QRCode(gameBox, qrConfig);
    if (apkBox) apkQR = new QRCode(apkBox, qrConfig);
    if (certBox) certQR = new QRCode(certBox, { ...qrConfig, width: 140, height: 140 });
    if (certCerBox) certCerQR = new QRCode(certCerBox, { ...qrConfig, width: 140, height: 140 });
    if (secureGameBox) secureGameQR = new QRCode(secureGameBox, qrConfig);
}

// 建立 WebSocket 通信
function connectWebSocket() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return;
    }

    clearTimeout(reconnectTimer);
    const host = window.location.hostname || "127.0.0.1";
    const wsScheme = isSecurePage ? "wss" : "ws";
    const targetUrl = `${wsScheme}://${host}:${currentWsPort}/console`;
    setConnectionHint(`正在连接后台: ${targetUrl}`);

    const socket = new WebSocket(targetUrl);
    ws = socket;

    socket.onopen = () => {
        if (ws !== socket) return;
        triedPortsCount = 0;
        setBackendStatus("online", "已连接");
        setConnectionHint("通信已建立，等待数据...");
    };

    socket.onmessage = (event) => {
        if (ws !== socket) return;
        let data = null;
        try {
            data = JSON.parse(event.data);
        } catch (error) {
            console.warn("无法解析后台消息:", error);
            return;
        }

        if (data.type === "state_update") {
            updateUI(data);
        } else if (data.type === "game_latency") {
            updateGameLatency(data.latency);
        } else if (data.type === "test_feedback") {
            setConsoleTestResult(data.message || "测试请求已处理", data.ok);
        } else if (data.type === "stop_feedback") {
            setConsoleTestResult(data.message || "停止请求已处理", data.ok);
        } else if (data.type === "device_feedback") {
            setText("device-selection-result", data.message || "设备选择已处理");
        }
    };

    socket.onclose = (event) => {
        if (ws !== socket) return;
        ws = null;
        setBackendStatus("offline", "未连接");
        if (event.code === 1008) {
            setConnectionHint("请在本地主机使用 127.0.0.1 打开。");
            return;
        }

        setConnectionHint("后台通信离线，请确认服务已启动。");

        if ((isSecurePage && hasPinnedSecureWsPort) || (!isSecurePage && hasPinnedWsPort)) {
            reconnectTimer = setTimeout(connectWebSocket, 2000);
            return;
        }

        if (triedPortsCount < maxPortPortion) {
            triedPortsCount++;
            const startPort = isSecurePage ? 18444 : 18081;
            currentWsPort = startPort + (triedPortsCount % maxPortPortion);
            reconnectTimer = setTimeout(connectWebSocket, 100);
        } else {
            reconnectTimer = setTimeout(() => {
                triedPortsCount = 0;
                currentWsPort = isSecurePage ? 18444 : 18081;
                connectWebSocket();
            }, 2000);
        }
    };

    socket.onerror = () => {
        socket.close();
    };
}

// 渲染并刷新设备状态和技术参数 UI
function updateUI(data) {
    latestState = data;

    // 1. 顶栏极简状态胶囊与电量
    const statusTextNode = document.getElementById("backend-status-text");
    if (statusTextNode) {
        if (data.device_connected) {
            // 精简为短词：硬件 3.0 / 硬件 2.0 / 已连接
            const rawModel = data.device_model || "";
            if (rawModel.includes("3.0") || rawModel.includes("V3")) {
                statusTextNode.innerText = "硬件 3.0";
            } else if (rawModel.includes("2.0") || rawModel.includes("V2")) {
                statusTextNode.innerText = "硬件 2.0";
            } else {
                statusTextNode.innerText = rawModel || "硬件已连接";
            }
        } else if (data.app_connected) {
            statusTextNode.innerText = data.selection_required ? "请选设备" : "等待硬件";
        } else {
            statusTextNode.innerText = "未连接";
        }
    }

    const battText = formatBatteryLevel(data.battery_level);
    setText("battery-badge", `电量: ${battText}`);

    setText("device-status-detail", data.device_status_message || "等待设备状态同步。");
    renderDevicePicker(data);

    // 2. SVG 仪表盘动画与数值渲染
    const maxA = Number(data.limit_a) || 100;
    const curA = Number(data.strength_a) || 0;
    const maxB = Number(data.limit_b) || 100;
    const curB = Number(data.strength_b) || 0;

    setText("gauge-val-a", data.device_connected ? String(curA) : "0");
    setText("gauge-max-a", `/ ${data.device_connected ? (data.limit_a ?? "--") : "--"}`);
    const circleA = document.getElementById("gauge-circle-a");
    if (circleA) {
        const pctA = Math.max(0, Math.min(1, maxA > 0 ? (curA / maxA) : 0));
        circleA.style.strokeDashoffset = String(251.2 * (1 - pctA));
    }

    setText("gauge-val-b", data.device_connected ? String(curB) : "0");
    setText("gauge-max-b", `/ ${data.device_connected ? (data.limit_b ?? "--") : "--"}`);
    const circleB = document.getElementById("gauge-circle-b");
    if (circleB) {
        const pctB = Math.max(0, Math.min(1, maxB > 0 ? (curB / maxB) : 0));
        circleB.style.strokeDashoffset = String(251.2 * (1 - pctB));
    }

    // 3. App 扫码绑定二维码
    if (data.app_qrcode_url) {
        const appRendered = renderQRCode(appQR, data.app_qrcode_url, "App 绑定");
        setText(
            "app-url-text",
            appRendered
                ? "V4 协议就绪，请使用 App 的 Socket 控制扫码"
                : `绑定数据：${data.app_qrcode_url}`
        );
    } else {
        setText("app-url-text", "等待生成绑定二维码...");
    }

    // 4. 手机端二维码与地址生成
    const gameToken = encodeURIComponent(data.game_token || "");
    const gameUrl = `http://${data.local_ip}:${data.http_port}/static/game.html?ws=${data.web_ws_port}&token=${gameToken}`;
    setText("game-url-text", gameUrl);
    renderQRCode(gameQR, gameUrl, "普通网页端");

    const apkConnectUrl = `gamebridgeforfun://connect?url=${encodeURIComponent(gameUrl)}`;
    setText("apk-url-text", apkConnectUrl);
    renderQRCode(apkQR, apkConnectUrl, "Android APK");

    // 5. 证书与 HTTPS 链接
    const certHost = data.local_ip || window.location.hostname || "127.0.0.1";
    const certifiedHost = data.certified_lan_ip || certHost;
    const profilePath = data.cert_profile_path || "/certs/gamebridge-for-fun-root-ca.mobileconfig";
    const cerPath = data.cert_cer_path || "/certs/gamebridge-for-fun-root-ca.cer";
    const profileUrl = `http://${certHost}:${data.http_port}${profilePath}`;
    const cerUrl = `http://${certHost}:${data.http_port}${cerPath}`;

    setText("cert-profile-url", profileUrl);
    setText("cert-cer-url", cerUrl);
    setText("cert-signed-ip", certifiedHost);
    setText("cert-ip-mode", data.cert_ip_mode || "-");
    setText("cert-root-expiry", formatCertificateExpiry(data.cert_root_not_after, data.cert_root_valid_days));
    setText("cert-server-expiry", formatCertificateExpiry(data.cert_server_not_after, data.cert_server_valid_days));
    setText("cert-fingerprint", formatFingerprint(data.cert_sha256));
    setDownloadLink("cert-profile-link", profileUrl, "gamebridge-for-fun-root-ca.mobileconfig");
    setDownloadLink("cert-cer-link", cerUrl, "gamebridge-for-fun-root-ca.cer");
    renderQRCode(certQR, profileUrl, "iOS 证书");
    renderQRCode(certCerQR, cerUrl, "Android 证书");

    if (data.https_enabled && data.https_port && data.secure_web_ws_port) {
        const secureGameUrl = `https://${certifiedHost}:${data.https_port}/static/game.html?ws=${data.secure_web_ws_port}&token=${gameToken}`;
        setText("secure-game-url-text", secureGameUrl);
        renderQRCode(secureGameQR, secureGameUrl, "HTTPS 网页");
    } else {
        setText("secure-game-url-text", "HTTPS 服务未启用");
        clearQRCode(secureGameQR);
    }

    // 6. 更新技术状态表格
    setText("stat-app-version", data.app_version || "-");
    setText("stat-ip", data.local_ip || "-");
    setText("stat-http-port", data.http_port || "-");
    setText("stat-web-ws-port", data.web_ws_port || "-");
    setText("stat-https-port", data.https_enabled ? data.https_port : "未启用");
    setText("stat-secure-web-ws-port", data.https_enabled ? data.secure_web_ws_port : "未启用");
    setText("stat-app-ws-port", data.app_ws_port || "-");
    setText("stat-bridge-protocol", data.bridge_protocol || "V4");
    setText("stat-device-model", data.device_model || "未连接");
    setText("stat-device-name", data.device_name || "未连接");
    setText("stat-device-connected", data.device_connected ? "已连接" : "未连接");

    const appLatency = Number(data.app_latency);
    if (Number.isFinite(appLatency) && appLatency >= 0) {
        setText("stat-app-latency", `${appLatency}ms`);
        setText("top-latency", `⚡ ${appLatency}ms`);
    } else {
        setText("stat-app-latency", "-");
        setText("top-latency", "⚡ --");
    }

    updateGameLatency(data.game_latency);
    setText("stat-limit-a", formatHardwareReading(data.limit_a, data.device_connected));
    setText("stat-limit-b", formatHardwareReading(data.limit_b, data.device_connected));
    setText("stat-battery-level", battText);
    setText("stat-safety-a", formatChannelSafety(data, "a"));
    setText("stat-safety-b", formatChannelSafety(data, "b"));
}

// 切换手机端接入视图 (APK / HTTPS / HTTP)
function switchConnectTab(mode) {
    const modes = ["apk", "https", "http"];
    modes.forEach((m) => {
        const btn = document.getElementById(`btn-mode-${m}`);
        const view = document.getElementById(`connect-view-${m}`);
        if (btn) btn.classList.toggle("active", m === mode);
        if (view) view.style.display = (m === mode) ? "block" : "none";
    });
}

function renderDevicePicker(data) {
    const select = document.getElementById("device-select");
    const confirmButton = document.getElementById("confirm-device-button");
    if (!select || !confirmButton) return;

    const devices = Array.isArray(data.compatible_devices) ? data.compatible_devices : [];
    const signature = JSON.stringify({
        devices: devices.map((d) => ({ id: d.selection_id, name: d.name, model: d.model, connected: d.connected })),
        selected: data.selected_device_id
    });

    if (signature !== renderedDeviceSignature) {
        renderedDeviceSignature = signature;
        const previousValue = select.value;
        select.replaceChildren();

        if (devices.length === 0) {
            const option = document.createElement("option");
            option.value = "";
            option.textContent = data.app_connected ? "App 尚未上报兼容设备" : "等待 App 上报设备...";
            select.appendChild(option);
        } else {
            for (const device of devices) {
                const option = document.createElement("option");
                option.value = device.selection_id;
                option.textContent = `${device.model} · ${device.name}${device.connected ? " · 已就绪" : " · 蓝牙未连接"}`;
                option.disabled = !device.connected;
                select.appendChild(option);
            }
        }

        const preferredValue = data.selected_device_id || previousValue;
        if (devices.some((device) => device.selection_id === preferredValue && device.connected)) {
            select.value = preferredValue;
        }
    }

    const selectedDevice = devices.find((device) => device.selection_id === select.value);
    select.disabled = devices.length === 0;
    confirmButton.disabled = !selectedDevice || !selectedDevice.connected;

    if (data.selection_required) {
        setText("device-selection-result", "必须先选择并确认一台已连接设备。");
    } else if (data.device_connected && data.device_model) {
        setText("device-selection-result", `当前控制：${data.device_model} · ${data.device_name || "设备就绪"}`);
    } else if (data.app_connected) {
        setText("device-selection-result", "请先在 App 中完成硬件蓝牙连接。");
    }
}

function selectDevice() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        setText("device-selection-result", "通信未连接，无法选择设备。");
        return;
    }
    const selectionId = document.getElementById("device-select")?.value || "";
    if (!selectionId) {
        setText("device-selection-result", "请先选择一台已连接设备。");
        return;
    }

    ws.send(JSON.stringify({ type: "select_device", selectionId }));
    setText("device-selection-result", "正在确认目标设备...");
}

// 步进调节函数
function stepConsoleStrength(delta) {
    const input1 = document.getElementById("console-test-strength");
    const input2 = document.getElementById("tab2-test-strength");
    const curVal = Number(input1?.value || input2?.value || DEFAULT_TEST_STRENGTH);
    const nextVal = Math.max(1, Math.min(30, Math.round(curVal + delta)));
    if (input1) input1.value = nextVal;
    if (input2) input2.value = nextVal;
    updateConsoleTestLabels();
}

function stepConsoleDuration(delta) {
    const input1 = document.getElementById("console-test-duration");
    const input2 = document.getElementById("tab2-test-duration");
    const curVal = Number(input1?.value || input2?.value || 1.0);
    const nextVal = Math.max(0.1, Math.min(1.0, Math.round((curVal + delta) * 10) / 10));
    if (input1) input1.value = nextVal;
    if (input2) input2.value = nextVal;
    updateConsoleTestLabels();
}

function syncTestStrength(val) {
    const input1 = document.getElementById("console-test-strength");
    if (input1) input1.value = val;
    updateConsoleTestLabels();
}

function syncTestDuration(val) {
    const input1 = document.getElementById("console-test-duration");
    if (input1) input1.value = val;
    updateConsoleTestLabels();
}

function updateConsoleTestLabels() {
    const strength = Number(document.getElementById("console-test-strength")?.value || DEFAULT_TEST_STRENGTH);
    const duration = Number(document.getElementById("console-test-duration")?.value || 1.0);
    const sStr = String(Number.isFinite(strength) ? Math.round(strength) : DEFAULT_TEST_STRENGTH);
    const dStr = `${(Number.isFinite(duration) ? duration : 1.0).toFixed(1)}s`;

    setText("val-console-test-strength", sStr);
    setText("val-console-test-duration", dStr);
    setText("tab2-val-strength", sStr);
    setText("tab2-val-duration", dStr);
}

function setConsoleTestResult(message, ok = true) {
    const node1 = document.getElementById("console-test-result");
    const node2 = document.getElementById("tab2-test-result");
    [node1, node2].forEach((node) => {
        if (node) {
            node.innerText = message;
            node.style.color = ok ? "var(--text-secondary)" : "var(--danger)";
        }
    });
}

function runConsoleSelfCheck() {
    if (!latestState) {
        setConsoleTestResult("后台状态同步中，请稍等。", false);
        return;
    }

    const checks = [
        ws && ws.readyState === WebSocket.OPEN ? "通信正常" : "通信未连接",
        latestState.app_connected ? "App 已绑定" : "App 未绑定",
        latestState.device_connected ? `${latestState.device_model || "硬件"}就绪` : "硬件未连接",
        latestState.game_connected ? "游戏端已连" : "游戏端未连",
        `A 限幅 ${formatHardwareReading(latestState.limit_a, latestState.device_connected)}`,
        `B 限幅 ${formatHardwareReading(latestState.limit_b, latestState.device_connected)}`
    ];
    const ok = Boolean(ws && ws.readyState === WebSocket.OPEN && latestState.device_connected);
    setConsoleTestResult(`自检：${checks.join("；")}`, ok);
}

function sendConsoleTestShock() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        setConsoleTestResult("通信未连接，无法试电。", false);
        return;
    }

    const outputMode = document.getElementById("console-test-output-mode")?.value || "a";
    if (!latestState?.device_connected) {
        setConsoleTestResult(latestState?.device_status_message || "硬件尚未就绪，无法试电。", false);
        return;
    }

    const limitA = Number(latestState.limit_a);
    const limitB = Number(latestState.limit_b);
    const aReady = Number.isFinite(limitA) && limitA > 0;
    const bReady = Number.isFinite(limitB) && limitB > 0;
    const selectedLimitReady = outputMode === "a" ? aReady : outputMode === "b" ? bReady : (aReady && bReady);
    if (!selectedLimitReady) {
        setConsoleTestResult("所选通道限幅未读取或为 0，不能试电。", false);
        return;
    }

    const strength = Math.round(Number(document.getElementById("console-test-strength")?.value || DEFAULT_TEST_STRENGTH));
    const durationSeconds = Number(document.getElementById("console-test-duration")?.value || 1.0);
    ws.send(JSON.stringify({
        type: "test_shock",
        outputMode,
        bStrengthMode: "same",
        bStrengthPercent: 100,
        strength,
        duration: Math.round(durationSeconds * 1000)
    }));
    setConsoleTestResult("已发送试电请求，等待后台响应。");
}

function stopConsoleOutput() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        setConsoleTestResult("通信未连接，无法发送停止。", false);
        return;
    }

    ws.send(JSON.stringify({ type: "stop_shock" }));
    setConsoleTestResult("已发送急停，停止 A/B 输出。");
}

function updateGameLatency(rtt) {
    const latency = Number(rtt);
    const latStr = (Number.isFinite(latency) && latency >= 0) ? `${latency}ms` : "-";
    setText("stat-game-latency", latStr);
}

function formatBatteryLevel(level) {
    if (level === null || level === undefined || level === "") return "未接入";
    const value = Number(level);
    return Number.isFinite(value) ? `${Math.round(value)}%` : "未接入";
}

function formatChannelSafety(data, channel) {
    if (!data.device_connected) return "未读取";
    if (data[`overheat_${channel}`]) return "过热保护";
    if (data[`muted_${channel}`]) return "静音封锁";

    const status = Number(data[`channel_status_${channel}`]);
    const statusLabels = {
        0: "正常就绪",
        1: "未形成回路",
        2: "输出正常",
        3: "输出异常",
        4: "通道屏蔽"
    };
    return Number.isInteger(status) && Object.prototype.hasOwnProperty.call(statusLabels, status)
        ? statusLabels[status]
        : "安全上限就绪";
}

function formatHardwareReading(value, appConnected) {
    if (!appConnected || value === null || value === undefined || value === "") return "未读取";
    const number = Number(value);
    return Number.isFinite(number) ? String(Math.round(number)) : "未读取";
}

function formatFingerprint(value) {
    if (!value) return "-";
    return String(value).match(/.{1,2}/g).join(":");
}

function formatCertificateExpiry(value, validDays) {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;

    const formatted = date.toLocaleString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
    });
    return validDays ? `${formatted}（${validDays}天策略）` : formatted;
}

function setDownloadLink(id, href, filename) {
    const node = document.getElementById(id);
    if (!node) return;
    node.href = href;
    node.setAttribute("download", filename);
}

// 切换顶栏 Tab
function switchTab(tabName) {
    const tabs = document.querySelectorAll(".tab");
    const contents = document.querySelectorAll(".tab-content");

    tabs.forEach((tab) => {
        const active = tab.dataset.tab === tabName;
        tab.classList.toggle("active", active);
        tab.setAttribute("aria-selected", String(active));
        tab.tabIndex = active ? 0 : -1;
    });
    contents.forEach((content) => {
        const active = content.id === `tab-${tabName}`;
        content.classList.toggle("active", active);
        content.hidden = !active;
    });
}

function bindTabKeyboardNavigation() {
    const tabs = Array.from(document.querySelectorAll(".tabs .tab[role='tab']"));
    tabs.forEach((tab, index) => {
        tab.addEventListener("keydown", (event) => {
            let targetIndex = null;
            if (event.key === "ArrowRight") targetIndex = (index + 1) % tabs.length;
            if (event.key === "ArrowLeft") targetIndex = (index - 1 + tabs.length) % tabs.length;
            if (event.key === "Home") targetIndex = 0;
            if (event.key === "End") targetIndex = tabs.length - 1;
            if (targetIndex === null) return;

            event.preventDefault();
            const target = tabs[targetIndex];
            switchTab(target.dataset.tab);
            target.focus();
        });
    });
}

// 页面加载就绪
window.addEventListener("DOMContentLoaded", () => {
    setConnectionHint("控制台正在连接后台...");
    setBackendStatus("", "未连接");
    updateConsoleTestLabels();
    bindTabKeyboardNavigation();

    try {
        initQRCodes();
    } catch (error) {
        console.error("二维码库初始化失败:", error);
    }

    connectWebSocket();
});
