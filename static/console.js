/* 电脑端控制台交互逻辑 console.js */

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
const renderedQrValues = new WeakMap();

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

/** 复制当前运行生成的地址；失败时保留原文，方便用户手动选中复制。 */
async function copyAddress(sourceId, resultId) {
    const source = document.getElementById(sourceId);
    const value = source?.innerText?.trim() || "";
    if (!value || value.startsWith("等待") || value.startsWith("正在")) {
        setText(resultId, "地址尚未生成，请稍等。");
        return;
    }

    try {
        await navigator.clipboard.writeText(value);
        setText(resultId, "已复制，可以到手机或 APK 中粘贴。");
    } catch (error) {
        console.warn("复制地址失败:", error);
        setText(resultId, "浏览器拒绝自动复制，请手动选中上方地址复制。");
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

    const appBox = document.getElementById("app-qrcode");
    const gameBox = document.getElementById("game-qrcode");
    const apkBox = document.getElementById("apk-qrcode");
    const certBox = document.getElementById("cert-qrcode");
    const certCerBox = document.getElementById("cert-cer-qrcode");
    const secureGameBox = document.getElementById("secure-game-qrcode");
    
    appQR = new QRCode(appBox, {
        width: 180,
        height: 180,
        typeNumber: 12,
        colorDark: "#07101f",
        colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.M
    });

    gameQR = new QRCode(gameBox, {
        width: 180,
        height: 180,
        typeNumber: 12,
        colorDark: "#07101f",
        colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.M
    });

    apkQR = new QRCode(apkBox, {
        width: 180,
        height: 180,
        typeNumber: 12,
        colorDark: "#07101f",
        colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.M
    });

    certQR = new QRCode(certBox, {
        width: 150,
        height: 150,
        typeNumber: 12,
        colorDark: "#07101f",
        colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.M
    });

    certCerQR = new QRCode(certCerBox, {
        width: 150,
        height: 150,
        typeNumber: 12,
        colorDark: "#07101f",
        colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.M
    });

    secureGameQR = new QRCode(secureGameBox, {
        width: 180,
        height: 180,
        typeNumber: 12,
        colorDark: "#07101f",
        colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.M
    });
}

// 自动探测并建立 WebSocket 连接
function connectWebSocket() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return;
    }

    clearTimeout(reconnectTimer);
    const host = window.location.hostname || "127.0.0.1";
    const wsScheme = isSecurePage ? "wss" : "ws";
    const targetUrl = `${wsScheme}://${host}:${currentWsPort}/console`;
    setConnectionHint(`正在连接后台通信: ${targetUrl}`);
    
    const socket = new WebSocket(targetUrl);
    ws = socket;
    
    socket.onopen = () => {
        if (ws !== socket) return;
        console.log(`控制台连接成功: ${targetUrl}`);
        triedPortsCount = 0;
        setBackendStatus("online", "后台已连接");
        setConnectionHint("后台通信已连接，正在等待二维码数据...");
    };
    
    socket.onmessage = (event) => {
        if (ws !== socket) return;
        let data = null;
        try {
            data = JSON.parse(event.data);
        } catch (error) {
            console.warn("收到无法解析的后台消息:", error);
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
        } else if (data.type === "button_feedback") {
            console.log(`收到设备物理按键: ${data.button}`);
        }
    };
    
    socket.onclose = (event) => {
        // 旧连接的迟到回调不能覆盖新连接状态，更不能安排第二条并行重连链。
        if (ws !== socket) return;
        ws = null;
        setBackendStatus("offline", "后台已离线");
        if (event.code === 1008) {
            setConnectionHint("控制台只允许在运行服务的这台电脑上打开，请使用终端显示的 127.0.0.1 地址。");
            return;
        }

        setConnectionHint("后台通信离线：请确认 start.command 终端窗口仍在运行，然后刷新本页。");

        if ((isSecurePage && hasPinnedSecureWsPort) || (!isSecurePage && hasPinnedWsPort)) {
            reconnectTimer = setTimeout(connectWebSocket, 2000);
            return;
        }

        // 如果未连上，自适应寻找下一个端口
        if (triedPortsCount < maxPortPortion) {
            triedPortsCount++;
            const startPort = isSecurePage ? 18444 : 18081;
            currentWsPort = startPort + (triedPortsCount % maxPortPortion);
            reconnectTimer = setTimeout(connectWebSocket, 100);
        } else {
            // 已完全断开，每 2 秒尝试重连
            reconnectTimer = setTimeout(() => {
                triedPortsCount = 0;
                currentWsPort = isSecurePage ? 18444 : 18081;
                connectWebSocket();
            }, 2000);
        }
    };
    
    socket.onerror = () => {
        // 必须关闭实际报错的连接；使用全局 ws 会误关掉已经替换成功的新连接。
        socket.close();
    };
}

// 渲染并刷新设备状态和技术参数 UI
function updateUI(data) {
    latestState = data;

    // 1. 更新连接状态
    const statusSpan = document.getElementById("conn-status");
    if (data.app_connected) {
        statusSpan.innerText = "已绑定";
        statusSpan.classList.add("connected");
    } else {
        statusSpan.innerText = "等待绑定";
        statusSpan.classList.remove("connected");
    }

    // 2. 更新 App 扫码绑定二维码
    if (data.app_qrcode_url) {
        const appRendered = renderQRCode(appQR, data.app_qrcode_url, "App 绑定");
        setText(
            "app-url-text",
            appRendered
                ? "绑定二维码已生成；如二维码未显示，请刷新本页。"
                : `二维码生成失败，绑定数据：${data.app_qrcode_url}`
        );
    } else {
        setText("app-url-text", "等待后台生成绑定二维码...");
    }

    // 3. 更新手机小游戏扫码和地址
    const gameToken = encodeURIComponent(data.game_token || "");
    const gameUrl = `http://${data.local_ip}:${data.http_port}/static/game.html?ws=${data.web_ws_port}&token=${gameToken}`;
    setText("game-url-text", gameUrl);
    const gameRendered = renderQRCode(gameQR, gameUrl, "游戏操纵端");
    if (!gameRendered) {
        setText("game-url-text", `二维码生成失败，可手动输入：${gameUrl}`);
    }

    // APK 读取同一个普通游戏地址，但由 Android 原生层提供传感器，因此无需 HTTPS 证书。
    const apkConnectUrl = `gamebridgeforfun://connect?url=${encodeURIComponent(gameUrl)}`;
    setText("apk-url-text", apkConnectUrl);
    const apkRendered = renderQRCode(apkQR, apkConnectUrl, "Android APK 配对");
    if (!apkRendered) {
        setText("apk-url-text", `二维码生成失败，可复制到 APK：${gameUrl}`);
    }

    // 4. 手机证书安装与 HTTPS 游戏入口。根证书用 HTTP 下载，游戏用 HTTPS/WSS 运行。
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
    renderQRCode(certQR, profileUrl, "证书安装");
    renderQRCode(certCerQR, cerUrl, "Android 证书安装");

    if (data.https_enabled && data.https_port && data.secure_web_ws_port) {
        const secureGameUrl = `https://${certifiedHost}:${data.https_port}/static/game.html?ws=${data.secure_web_ws_port}&token=${gameToken}`;
        setText("secure-game-url-text", secureGameUrl);
        setText("secure-game-hint", `手抖挑战和保持角度请先安装手机证书，再使用 HTTPS 入口：${secureGameUrl}`);
        renderQRCode(secureGameQR, secureGameUrl, "HTTPS 游戏操纵端");
    } else {
        setText("secure-game-url-text", "HTTPS 服务未启用：请确认 openssl 可用并重启服务。");
        setText("secure-game-hint", "HTTPS 服务未启用；手抖挑战和保持角度可能无法取得手机感应器权限。");
        clearQRCode(secureGameQR);
    }

    // 5. 更新技术状态表格
    document.getElementById("stat-ip").innerText = data.local_ip;
    document.getElementById("stat-http-port").innerText = data.http_port;
    document.getElementById("stat-web-ws-port").innerText = data.web_ws_port;
    document.getElementById("stat-https-port").innerText = data.https_enabled ? data.https_port : "未启用";
    document.getElementById("stat-secure-web-ws-port").innerText = data.https_enabled ? data.secure_web_ws_port : "未启用";
    document.getElementById("stat-cert-ip").innerText = certifiedHost;
    document.getElementById("stat-root-expiry").innerText = formatCertificateExpiry(data.cert_root_not_after, data.cert_root_valid_days);
    document.getElementById("stat-server-expiry").innerText = formatCertificateExpiry(data.cert_server_not_after, data.cert_server_valid_days);
    document.getElementById("stat-app-ws-port").innerText = data.app_ws_port;
    
    // 延迟格式化显示 (冷峻标记)
    const statAppLat = document.getElementById("stat-app-latency");
    const appLatency = Number(data.app_latency);
    if (Number.isFinite(appLatency) && appLatency >= 0) {
        statAppLat.innerText = `${appLatency}ms`;
        statAppLat.className = getLatencyClass(appLatency);
    } else {
        statAppLat.innerText = "-";
        statAppLat.className = "";
    }

    updateGameLatency(data.game_latency);
    document.getElementById("stat-game-connected").innerText = data.game_connected ? "已连接" : "未连接";
    document.getElementById("stat-strength-a").innerText = formatHardwareReading(data.strength_a, data.app_connected);
    document.getElementById("stat-strength-b").innerText = formatHardwareReading(data.strength_b, data.app_connected);
    document.getElementById("stat-limit-a").innerText = formatHardwareReading(data.limit_a, data.app_connected);
    document.getElementById("stat-limit-b").innerText = formatHardwareReading(data.limit_b, data.app_connected);
    document.getElementById("stat-battery-level").innerText = formatBatteryLevel(data.battery_level);

}

function updateConsoleTestLabels() {
    const strength = Number(document.getElementById("console-test-strength")?.value || 5);
    const duration = Number(document.getElementById("console-test-duration")?.value || 0.3);
    setText("val-console-test-strength", Number.isFinite(strength) ? Math.round(strength) : "5");
    setText("val-console-test-duration", Number.isFinite(duration) ? `${duration.toFixed(1)}s` : "0.3s");
}

function setConsoleTestResult(message, ok = true) {
    const node = document.getElementById("console-test-result");
    if (!node) return;
    node.innerText = message;
    node.style.color = ok ? "var(--text-secondary)" : "var(--danger)";
}

function runConsoleSelfCheck() {
    if (!latestState) {
        setConsoleTestResult("后台状态尚未同步，请稍等。", false);
        return;
    }

    const checks = [
        ws && ws.readyState === WebSocket.OPEN ? "控制台已连接" : "控制台未连接",
        latestState.app_connected ? "App 已绑定" : "App 未绑定",
        latestState.game_connected ? "手机游戏页已连接" : "手机游戏页未连接",
        latestState.https_enabled ? "HTTPS 已启用" : "HTTPS 未启用",
        `A 限幅 ${formatHardwareReading(latestState.limit_a, latestState.app_connected)}`,
        `B 限幅 ${formatHardwareReading(latestState.limit_b, latestState.app_connected)}`
    ];
    const ok = Boolean(ws && ws.readyState === WebSocket.OPEN && latestState.app_connected);
    setConsoleTestResult(`自检结果：${checks.join("；")}`, ok);
}

function sendConsoleTestShock() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        setConsoleTestResult("后台通信未连接，不能试电。", false);
        return;
    }

    const outputMode = document.getElementById("console-test-output-mode")?.value || "a";
    if (!latestState?.app_connected) {
        setConsoleTestResult("设备 App 尚未绑定，不能试电。", false);
        return;
    }

    const limitA = Number(latestState.limit_a);
    const limitB = Number(latestState.limit_b);
    const aReady = Number.isFinite(limitA) && limitA > 0;
    const bReady = Number.isFinite(limitB) && limitB > 0;
    const selectedLimitReady = outputMode === "a"
        ? aReady
        : outputMode === "b"
            ? bReady
            : aReady && bReady;
    if (!selectedLimitReady) {
        setConsoleTestResult("所选通道限幅尚未读取或已设为 0，不能试电。", false);
        return;
    }

    const strength = Math.round(Number(document.getElementById("console-test-strength")?.value || 5));
    const durationSeconds = Number(document.getElementById("console-test-duration")?.value || 0.3);
    ws.send(JSON.stringify({
        type: "test_shock",
        outputMode,
        bStrengthMode: "same",
        bStrengthPercent: 100,
        strength,
        duration: Math.round(durationSeconds * 1000)
    }));
    setConsoleTestResult("已发送测试请求，等待后台确认。");
}

function stopConsoleOutput() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        setConsoleTestResult("后台通信未连接，不能发送停止请求。", false);
        return;
    }

    ws.send(JSON.stringify({ type: "stop_shock" }));
    setConsoleTestResult("已请求停止 A/B 输出。");
}

function updateGameLatency(rtt) {
    const gameLatTd = document.getElementById("stat-game-latency");
    const latency = Number(rtt);
    if (Number.isFinite(latency) && latency >= 0) {
        gameLatTd.innerText = `${latency}ms`;
        gameLatTd.className = getLatencyClass(latency);
    } else {
        gameLatTd.innerText = "-";
        gameLatTd.className = "";
    }
}

function formatBatteryLevel(level) {
    if (level === null || level === undefined || level === "") return "未接入";
    const value = Number(level);
    if (!Number.isFinite(value)) return "未接入";
    return `${Math.round(value)}%`;
}

function formatHardwareReading(value, appConnected) {
    // null 表示 App 尚未回传该字段；不能把它格式化成 0，否则用户会误判通道限幅已经生效。
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
    return validDays ? `${formatted}（${validDays} 天策略）` : formatted;
}

function setDownloadLink(id, href, filename) {
    const node = document.getElementById(id);
    if (!node) return;
    node.href = href;
    node.setAttribute("download", filename);
}

function getLatencyClass(rtt) {
    if (rtt <= 30) return "latency-excellent";
    if (rtt <= 100) return "latency-normal";
    return "latency-bad";
}

// Tab 状态由 data-tab 驱动，不再依赖按钮排列顺序，后续调整页面顺序不会切错内容。
function switchTab(tabName) {
    const tabs = document.querySelectorAll(".tab");
    const contents = document.querySelectorAll(".tab-content");

    tabs.forEach((tab) => {
        const active = tab.dataset.tab === tabName;
        tab.classList.toggle("active", active);
        tab.setAttribute("aria-selected", String(active));
    });
    contents.forEach(c => c.classList.remove("active"));
    document.getElementById(`tab-${tabName}`)?.classList.add("active");
}

// 页面加载就绪后执行
window.addEventListener("DOMContentLoaded", () => {
    setConnectionHint("控制台脚本已启动，正在连接后台...");
    setBackendStatus("", "后台连接中");
    updateConsoleTestLabels();

    /*
       二维码库只负责“画图”，不能决定后台是否连接。
       如果二维码库在某个浏览器里加载失败，仍然先连 WebSocket，把手动地址显示出来。
    */
    try {
        initQRCodes();
    } catch (error) {
        console.error("二维码库初始化失败:", error);
        setText("app-url-text", "二维码库加载失败；连接后台后会显示可手动复制的绑定数据。");
    }

    connectWebSocket();
});
