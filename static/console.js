/* 电脑端控制台交互逻辑 console.js */

let ws = null;
let currentWsPort = 18081; // 默认探测起点端口
const maxPortPortion = 10;  // 最大端口探测范围
let triedPortsCount = 0;

let appQR = null;
let gameQR = null;

// 初始化二维码实例
function initQRCodes() {
    const appBox = document.getElementById("app-qrcode");
    const gameBox = document.getElementById("game-qrcode");
    
    appQR = new QRCode(appBox, {
        width: 180,
        height: 180,
        colorDark: "#ffffff",
        colorLight: "#000000",
        correctLevel: QRCode.CorrectLevel.H
    });

    gameQR = new QRCode(gameBox, {
        width: 180,
        height: 180,
        colorDark: "#ffffff",
        colorLight: "#000000",
        correctLevel: QRCode.CorrectLevel.H
    });
}

// 自动探测并建立 WebSocket 连接
function connectWebSocket() {
    const host = window.location.hostname || "127.0.0.1";
    const targetUrl = `ws://${host}:${currentWsPort}/console`;
    
    ws = new WebSocket(targetUrl);
    
    ws.onopen = () => {
        console.log(`控制台连接成功: ${targetUrl}`);
        triedPortsCount = 0;
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
        // 如果未连上，自适应寻找下一个端口
        if (triedPortsCount < maxPortPortion) {
            triedPortsCount++;
            currentWsPort = 18081 + (triedPortsCount % maxPortPortion);
            setTimeout(connectWebSocket, 100);
        } else {
            // 已完全断开，每 2 秒尝试重连
            setTimeout(() => {
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
        appQR.clear();
        appQR.makeCode(data.app_qrcode_url);
    }

    // 3. 更新手机小游戏扫码和地址
    const gameToken = encodeURIComponent(data.game_token || "");
    const gameUrl = `http://${data.local_ip}:${data.http_port}/static/game.html?ws=${data.web_ws_port}&token=${gameToken}`;
    document.getElementById("game-url-text").innerText = gameUrl;
    gameQR.clear();
    gameQR.makeCode(gameUrl);

    // 4. 更新技术状态表格
    document.getElementById("stat-ip").innerText = data.local_ip;
    document.getElementById("stat-http-port").innerText = data.http_port;
    document.getElementById("stat-web-ws-port").innerText = data.web_ws_port;
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

    // 5. 更新 Settings 面板输入框
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
    } else {
        tabs[1].classList.add("active");
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
window.onload = () => {
    initQRCodes();
    connectWebSocket();
};
