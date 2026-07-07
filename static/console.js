/* 电脑端控制台交互逻辑 console.js */

let ws = null;
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
let certQR = null;
let secureGameQR = null;

function setText(id, value) {
    const node = document.getElementById(id);
    if (node) {
        node.innerText = value;
    }
}

function setConnectionHint(message) {
    setText("game-url-text", message);
}

function renderQRCode(instance, text, targetName) {
    if (!instance || !text) return false;

    try {
        instance.clear();
        instance.makeCode(text);
        return true;
    } catch (error) {
        console.error(`${targetName}二维码生成失败:`, error);
        return false;
    }
}

// 初始化二维码实例
function initQRCodes() {
    if (typeof QRCode === "undefined") {
        throw new Error("QRCode library is not loaded");
    }

    const appBox = document.getElementById("app-qrcode");
    const gameBox = document.getElementById("game-qrcode");
    const certBox = document.getElementById("cert-qrcode");
    const secureGameBox = document.getElementById("secure-game-qrcode");
    
    appQR = new QRCode(appBox, {
        width: 180,
        height: 180,
        typeNumber: 12,
        colorDark: "#ffffff",
        colorLight: "#000000",
        correctLevel: QRCode.CorrectLevel.M
    });

    gameQR = new QRCode(gameBox, {
        width: 180,
        height: 180,
        typeNumber: 12,
        colorDark: "#ffffff",
        colorLight: "#000000",
        correctLevel: QRCode.CorrectLevel.M
    });

    certQR = new QRCode(certBox, {
        width: 180,
        height: 180,
        typeNumber: 12,
        colorDark: "#ffffff",
        colorLight: "#000000",
        correctLevel: QRCode.CorrectLevel.M
    });

    secureGameQR = new QRCode(secureGameBox, {
        width: 180,
        height: 180,
        typeNumber: 12,
        colorDark: "#ffffff",
        colorLight: "#000000",
        correctLevel: QRCode.CorrectLevel.M
    });
}

// 自动探测并建立 WebSocket 连接
function connectWebSocket() {
    const host = window.location.hostname || "127.0.0.1";
    const wsScheme = isSecurePage ? "wss" : "ws";
    const targetUrl = `${wsScheme}://${host}:${currentWsPort}/console`;
    setConnectionHint(`正在连接后台通信: ${targetUrl}`);
    
    ws = new WebSocket(targetUrl);
    
    ws.onopen = () => {
        console.log(`控制台连接成功: ${targetUrl}`);
        triedPortsCount = 0;
        setConnectionHint("后台通信已连接，正在等待二维码数据...");
    };
    
    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        
        if (data.type === "state_update") {
            updateUI(data);
        } else if (data.type === "game_latency") {
            updateGameLatency(data.latency);
        } else if (data.type === "button_feedback") {
            console.log(`收到设备物理按键: ${data.button}`);
        }
    };
    
    ws.onclose = () => {
        setConnectionHint("后台通信离线：请确认 start.command 终端窗口仍在运行，然后刷新本页。");

        if ((isSecurePage && hasPinnedSecureWsPort) || (!isSecurePage && hasPinnedWsPort)) {
            setTimeout(connectWebSocket, 2000);
            return;
        }

        // 如果未连上，自适应寻找下一个端口
        if (triedPortsCount < maxPortPortion) {
            triedPortsCount++;
            const startPort = isSecurePage ? 18444 : 18081;
            currentWsPort = startPort + (triedPortsCount % maxPortPortion);
            setTimeout(connectWebSocket, 100);
        } else {
            // 已完全断开，每 2 秒尝试重连
            setTimeout(() => {
                triedPortsCount = 0;
                currentWsPort = isSecurePage ? 18444 : 18081;
                connectWebSocket();
            }, 2000);
        }
    };
    
    ws.onerror = () => {
        ws.close();
    };
}

// 渲染并刷新设备状态和技术参数 UI
function updateUI(data) {
    // 1. 更新连接状态
    const statusSpan = document.getElementById("conn-status");
    if (data.app_connected) {
        statusSpan.innerText = "已绑定";
        statusSpan.style.color = "#ffffff";
    } else {
        statusSpan.innerText = "等待绑定";
        statusSpan.style.color = "#444444";
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

    // 4. iPhone 证书安装与 HTTPS 游戏入口。证书用 HTTP 下载，游戏用 HTTPS/WSS 运行。
    const certHost = data.local_ip || window.location.hostname || "127.0.0.1";
    const certifiedHost = data.certified_lan_ip || certHost;
    const profilePath = data.cert_profile_path || "/certs/dg-lab-root-ca.mobileconfig";
    const cerPath = data.cert_cer_path || "/certs/dg-lab-root-ca.cer";
    const profileUrl = `http://${certHost}:${data.http_port}${profilePath}`;
    const cerUrl = `http://${certHost}:${data.http_port}${cerPath}`;

    setText("cert-profile-url", profileUrl);
    setText("cert-fingerprint", formatFingerprint(data.cert_sha256));
    setDownloadLink("cert-profile-link", profileUrl, "dg-lab-root-ca.mobileconfig");
    setDownloadLink("cert-cer-link", cerUrl, "dg-lab-root-ca.cer");
    renderQRCode(certQR, profileUrl, "证书安装");

    if (data.https_enabled && data.https_port && data.secure_web_ws_port) {
        const secureGameUrl = `https://${certifiedHost}:${data.https_port}/static/game.html?ws=${data.secure_web_ws_port}&token=${gameToken}`;
        setText("secure-game-url-text", secureGameUrl);
        setText("secure-game-hint", `手抖挑战和保持角度请先安装证书，再使用 HTTPS 入口：${secureGameUrl}`);
        renderQRCode(secureGameQR, secureGameUrl, "HTTPS 游戏操纵端");
    } else {
        setText("secure-game-url-text", "HTTPS 服务未启用：请确认 openssl 可用并重启服务。");
        setText("secure-game-hint", "HTTPS 服务未启用；手抖挑战和保持角度可能无法取得 iPhone 感应器权限。");
        if (secureGameQR) secureGameQR.clear();
    }

    // 5. 更新技术状态表格
    document.getElementById("stat-ip").innerText = data.local_ip;
    document.getElementById("stat-http-port").innerText = data.http_port;
    document.getElementById("stat-web-ws-port").innerText = data.web_ws_port;
    document.getElementById("stat-https-port").innerText = data.https_enabled ? data.https_port : "未启用";
    document.getElementById("stat-secure-web-ws-port").innerText = data.https_enabled ? data.secure_web_ws_port : "未启用";
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
    document.getElementById("stat-strength-a").innerText = data.strength_a;
    document.getElementById("stat-strength-b").innerText = data.strength_b;
    document.getElementById("stat-limit-a").innerText = data.limit_a;
    document.getElementById("stat-limit-b").innerText = data.limit_b;
    document.getElementById("stat-battery-level").innerText = formatBatteryLevel(data.battery_level);

    // 6. 更新 Settings 面板输入框
    document.getElementById("input-http-port").value = data.http_port;
    document.getElementById("input-web-ws-port").value = data.web_ws_port;
    document.getElementById("input-app-ws-port").value = data.app_ws_port;
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

function formatFingerprint(value) {
    if (!value) return "-";
    return String(value).match(/.{1,2}/g).join(":");
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

// 极简 Tab 切换
function switchTab(tabName) {
    const tabs = document.querySelectorAll(".tab");
    const contents = document.querySelectorAll(".tab-content");

    tabs.forEach(t => t.classList.remove("active"));
    contents.forEach(c => c.classList.remove("active"));

    if (tabName === "monitor") {
        tabs[0].classList.add("active");
        document.getElementById("tab-monitor").classList.add("active");
    } else if (tabName === "cert") {
        tabs[1].classList.add("active");
        document.getElementById("tab-cert").classList.add("active");
    } else {
        tabs[2].classList.add("active");
        document.getElementById("tab-settings").classList.add("active");
    }
}

// 随机端口更换
function randomizePorts() {
    const randomPort = () => Math.floor(Math.random() * (29999 - 10000 + 1)) + 10000;
    document.getElementById("input-http-port").value = randomPort();
    document.getElementById("input-web-ws-port").value = randomPort();
    document.getElementById("input-app-ws-port").value = randomPort();
}

// 保存端口设置 (发送给后端热重启)
function applyPorts() {
    const httpPort = parseInt(document.getElementById("input-http-port").value);
    const webWSPort = parseInt(document.getElementById("input-web-ws-port").value);
    const appWSPort = parseInt(document.getElementById("input-app-ws-port").value);

    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            "type": "change_ports",
            "http_port": httpPort,
            "web_ws_port": webWSPort,
            "app_ws_port": appWSPort
        }));
        alert("当前版本不支持运行中热切端口，请重启服务后再使用新端口。");
    }
}

// 页面加载就绪后执行
window.addEventListener("DOMContentLoaded", () => {
    setConnectionHint("控制台脚本已启动，正在连接后台...");

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
