/* 手机小游戏端交互逻辑 game.js */

let ws = null;
let currentWsPort = 18081;
let latencyTimer = null;
let gameLoopTimer = null;

// 当前选择的游戏名称: 'shake' (手抖), 'angle' (保持角度), 'dice' (摇骰子)
let activeGame = null;

// 游戏运行标志与传感器状态
let sensorsAllowed = false;
let phoneBeta = 0;   // 前后倾斜 (-180 ~ 180 度)
let phoneGamma = 0;  // 左右倾斜 (-90 ~ 90 度)
let shakeAcc = 0;    // 当前晃动总加速度

// Canvas 与 绘图上下文
let canvas = null;
let ctx = null;
let animationFrameId = null;

// Web Audio API 上下文 (用于代码合成摇骰子碰撞音效)
let audioCtx = null;

// --- 游戏 1：手抖挑战状态 ---
let ballX = 0;
let ballY = 0;
let ballVx = 0;
let ballVy = 0;
const ballRadius = 8;
const friction = 0.98; // 摩擦力阻尼

// --- 游戏 3：摇骰子状态 ---
let isDiceShaking = false;
let lastShakeTime = 0;
let lastVibrateTime = 0;
let shakeStopTimeout = null;

// --- 1. 设备传感器授权申请 (针对 iOS 13+) ---

async function requestSensorPermission() {
    if (sensorsAllowed) return true;
    
    // 检查是否在 iOS 上需要特权申请
    if (typeof DeviceOrientationEvent !== 'undefined' && 
        typeof DeviceOrientationEvent.requestPermission === 'function') {
        try {
            const permissionState = await DeviceOrientationEvent.requestPermission();
            if (permissionState === 'granted') {
                sensorsAllowed = true;
                return true;
            }
        } catch (error) {
            console.error("传感器授权失败:", error);
        }
        return false;
    } else {
        // 安卓或非 iOS 设备默认允许
        sensorsAllowed = true;
        return true;
    }
}

// 绑定传感器监听
function bindSensors() {
    // 监听倾斜角 (用于游戏 1 & 游戏 2)
    window.addEventListener('deviceorientation', (event) => {
        phoneBeta = event.beta || 0;
        phoneGamma = event.gamma || 0;
    });

    // 监听加速度 (用于游戏 3 摇骰子检测)
    window.addEventListener('devicemotion', (event) => {
        const acc = event.acceleration || event.accelerationIncludingGravity;
        if (acc) {
            const x = acc.x || 0;
            const y = acc.y || 0;
            const z = acc.z || 0;
            // 计算三轴总合成加速度 (刨去重力影响基准)
            shakeAcc = Math.sqrt(x*x + y*y + z*z);
            
            // 如果加速度大于 15，视为在晃动手机
            if (shakeAcc > 15 && activeGame === 'dice') {
                triggerDiceShake();
            }
        }
    });
}


// --- 2. Web Audio API 音效合成器 ---

function initAudio() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
}

function playDiceCollisionSound() {
    /* 
       利用 Web Audio API 纯代码实时合成骰子物理撞击音效。
       由两部分声音组成: 1. 类似摩擦的白噪声(沙沙声) 2. 具有衰减的谐振正弦波(啪嗒清脆碰撞声)
    */
    if (!audioCtx) return;
    
    const now = audioCtx.currentTime;
    
    // 1. 声音一：白噪声 (杯壁摩擦声)
    const bufferSize = audioCtx.sampleRate * 0.08; // 80毫秒的微短噪声
    const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
    }
    
    const noiseNode = audioCtx.createBufferSource();
    noiseNode.buffer = buffer;
    
    // 用 Bandpass 带通滤波器过滤噪声，使其听起来像塑料/骨质摩擦
    const filter = audioCtx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(1000, now);
    filter.Q.setValueAtTime(3.0, now);
    
    const noiseGain = audioCtx.createGain();
    noiseGain.gain.setValueAtTime(0.05, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    
    noiseNode.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(audioCtx.destination);
    noiseNode.start(now);

    // 2. 声音二：正弦振荡波 (骰子撞击骨质“啪嗒”声)
    const osc = audioCtx.createOscillator();
    const oscGain = audioCtx.createGain();
    
    osc.type = "sine";
    osc.frequency.setValueAtTime(150 + Math.random() * 80, now); // 撞击频率
    
    oscGain.gain.setValueAtTime(0.3, now);
    oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.05); // 快速衰减阻尼
    
    osc.connect(oscGain);
    oscGain.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.06);
}


// --- 3. WebSocket 网络连接与心跳延迟监控 ---

function connectWebSocket() {
    const host = window.location.hostname || "127.0.0.1";
    const targetUrl = `ws://${host}:${currentWsPort}/game`;
    
    ws = new WebSocket(targetUrl);
    
    ws.onopen = () => {
        console.log("游戏端连接成功");
        
        // 开启每 1 秒一次的应用层延迟心跳探测
        latencyTimer = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    "type": "ping",
                    "time": Date.now()
                }));
            }
        }, 1000);
    };
    
    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === "pong") {
            const rtt = Date.now() - data.time;
            document.getElementById("ping-badge").innerText = `网速延迟: ${rtt}ms`;
            
            // 向服务器回报延迟，让电脑端控制台 Settings 也能同步看到
            ws.send(JSON.stringify({
                "type": "latency_report",
                "rtt": rtt
            }));
        } else if (data.type === "button_feedback") {
            // 被迫接收设备按键回调 (通常忽略，可添加物理震动好玩一下)
            navigator.vibrate && navigator.vibrate(20);
        }
    };
    
    ws.onclose = () => {
        clearInterval(latencyTimer);
        setTimeout(connectWebSocket, 2000);
    };
    
    ws.onerror = () => {
        ws.close();
    };
}


// --- 4. 游戏框架交互控制 ---

function getSliderVal(id) {
    return parseFloat(document.getElementById(id).value);
}

function updateVal(id) {
    let val = document.getElementById(id).value;
    if (id === 'dice-time-min' || id === 'dice-time-max') {
        val = parseFloat(val).toFixed(1);
    }
    document.getElementById(`val-${id}`).innerText = val;
}

async function startGame(gameName) {
    // 1. 激活传感器授权与音频上下文
    const allowed = await requestSensorPermission();
    if (!allowed) {
        alert("提示: 需要允许访问运动与方向感应权限以玩游戏。");
        return;
    }
    
    bindSensors();
    initAudio();
    
    // 解锁音频上下文安全锁
    if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume();
    }

    activeGame = gameName;
    
    // 2. 面板切换
    document.getElementById("screen-select").style.display = "none";
    document.getElementById("screen-play").style.display = "block";
    
    // 隐藏所有特定游戏设置面板
    document.querySelectorAll(".game-settings").forEach(s => s.style.display = "none");
    document.getElementById("game-viewport").style.display = "none";
    document.getElementById("dice-viewport").style.display = "none";

    // 停止上一次运行的帧渲染循环
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
    }
    clearInterval(gameLoopTimer);

    // 3. 运行对应游戏初始化
    const title = document.getElementById("game-title");
    
    if (gameName === 'shake') {
        title.innerText = "手抖挑战";
        document.getElementById("settings-shake").style.display = "block";
        document.getElementById("game-viewport").style.display = "block";
        initShakeGame();
    } else if (gameName === 'angle') {
        title.innerText = "保持角度";
        document.getElementById("settings-angle").style.display = "block";
        document.getElementById("game-viewport").style.display = "block";
        initAngleGame();
    } else if (gameName === 'dice') {
        title.innerText = "摇骰子对决";
        document.getElementById("settings-dice").style.display = "block";
        document.getElementById("dice-viewport").style.display = "block";
        initDiceGame();
    }
}

function exitGame() {
    activeGame = null;
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    clearInterval(gameLoopTimer);
    
    document.getElementById("screen-play").style.display = "none";
    document.getElementById("screen-select").style.display = "block";
}


// --- 5. 游戏 1: 手抖挑战运行逻辑 ---

function initShakeGame() {
    canvas = document.getElementById("game-canvas");
    ctx = canvas.getContext("2d");
    
    // 适配物理屏幕像素比
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    ctx.scale(dpr, dpr);
    
    // 将小球置于中心点
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    ballX = width / 2;
    ballY = height / 2;
    ballVx = 0;
    ballVy = 0;
    
    // 开启物理位置渲染循环
    runShakeLoop();
    
    // 开启 100ms 惩罚数据检测上报定时器
    clearInterval(gameLoopTimer);
    gameLoopTimer = setInterval(checkShakePunish, 100);
}

function runShakeLoop() {
    if (activeGame !== 'shake') return;
    
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    const centerX = width / 2;
    const centerY = height / 2;

    // 清屏全黑
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, width, height);

    // 1. 获取配置数据
    const mode = document.getElementById("shake-mode").value;
    const radius = getSliderVal("shake-radius");

    // 2. 根据手机偏角注入重力加速度 (限制极值)
    // 偏角转为重力分量加速度
    const limitBeta = Math.max(-45, Math.min(45, phoneBeta));
    const limitGamma = Math.max(-45, Math.min(45, phoneGamma));
    
    // 施加力
    ballVx += limitGamma * 0.05;
    ballVy += limitBeta * 0.05;
    
    // 摩擦力衰减
    ballVx *= friction;
    ballVy *= friction;
    
    ballX += ballVx;
    ballY += ballVy;

    // 3. 边界碰撞检测物理弹回
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

    // 4. 画辅助纯白线条
    ctx.strokeStyle = "#222222";
    ctx.lineWidth = 1;
    
    // 绘制十字准心
    ctx.beginPath();
    ctx.moveTo(centerX - 15, centerY);
    ctx.lineTo(centerX + 15, centerY);
    ctx.moveTo(centerX, centerY - 15);
    ctx.lineTo(centerX, centerY + 15);
    ctx.stroke();

    // 绘制安全范围
    ctx.strokeStyle = "#ffffff";
    ctx.beginPath();
    if (mode === "radius") {
        ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    } else {
        // 夹缝生存模式：内圈 30px，外圈根据设定
        ctx.arc(centerX, centerY, 30, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius + 30, 0, Math.PI * 2);
    }
    ctx.stroke();

    // 5. 绘制弹珠
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(ballX, ballY, ballRadius, 0, Math.PI * 2);
    ctx.fill();

    animationFrameId = requestAnimationFrame(runShakeLoop);
}

function checkShakePunish() {
    if (activeGame !== 'shake' || !ws || ws.readyState !== WebSocket.OPEN) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    const centerX = width / 2;
    const centerY = height / 2;

    const dx = ballX - centerX;
    const dy = ballY - centerY;
    const dist = Math.sqrt(dx*dx + dy*dy);

    const mode = document.getElementById("shake-mode").value;
    const radius = getSliderVal("shake-radius");
    const baseStrength = getSliderVal("base-strength");
    const maxStrength = getSliderVal("max-strength");

    let err = 0;
    let maxErr = 100; // 预估的最大偏离上限，用以线性计算

    if (mode === "radius") {
        if (dist > radius) {
            err = dist - radius;
        }
    } else {
        // 夹缝生存模式：内圈 30px，外圈 (radius + 30)px 为安全带
        const inner = 30;
        const outer = radius + 30;
        if (dist < inner) {
            err = inner - dist;
        } else if (dist > outer) {
            err = dist - outer;
        }
    }

    if (err > 0) {
        // 偏移量线性惩罚力度映射
        const ratio = Math.min(1.0, err / maxErr);
        const strength = baseStrength + (maxStrength - baseStrength) * ratio;
        
        ws.send(JSON.stringify({
            "type": "game_pulse",
            "strength": Math.round(strength)
        }));
        
        // 玩家触觉惩罚振动同步
        navigator.vibrate && navigator.vibrate(50);
    }
}


// --- 6. 游戏 2: 保持角度运行逻辑 ---

function initAngleGame() {
    canvas = document.getElementById("game-canvas");
    ctx = canvas.getContext("2d");
    
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    ctx.scale(dpr, dpr);

    runAngleLoop();

    clearInterval(gameLoopTimer);
    gameLoopTimer = setInterval(checkAnglePunish, 100);
}

function runAngleLoop() {
    if (activeGame !== 'angle') return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    const centerX = width / 2;
    const centerY = height - 30; // 表盘底部中心
    const radius = Math.min(width, height) - 50;

    // 清屏
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, width, height);

    // 获取配置安全弧度区间
    const angleMin = getSliderVal("angle-min");
    const angleMax = getSliderVal("angle-max");

    // 绘制半圆表盘
    ctx.strokeStyle = "#222222";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, Math.PI, 0);
    ctx.stroke();

    // 绘制安全区弧段 (极细白虚线)
    ctx.strokeStyle = "#ffffff";
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    // 0度在水平右侧，90度直立。转换：
    const startRad = Math.PI - (angleMax * Math.PI / 180);
    const endRad = Math.PI - (angleMin * Math.PI / 180);
    ctx.arc(centerX, centerY, radius, startRad, endRad);
    ctx.stroke();
    ctx.setLineDash([]); // 还原实线

    // 绘制指针 (代表手机前后倾斜角度 phoneBeta)
    // phoneBeta 通常倾斜手持在 0~90度
    const currentAngle = Math.max(0, Math.min(90, phoneBeta));
    const pointerRad = Math.PI - (currentAngle * Math.PI / 180);
    const px = centerX + radius * Math.cos(pointerRad);
    const py = centerY + radius * Math.sin(pointerRad);

    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(centerX, centerY);
    ctx.lineTo(px, py);
    ctx.stroke();

    // 绘制中心螺丝点
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(centerX, centerY, 5, 0, Math.PI * 2);
    ctx.fill();

    animationFrameId = requestAnimationFrame(runAngleLoop);
}

function checkAnglePunish() {
    if (activeGame !== 'angle' || !ws || ws.readyState !== WebSocket.OPEN) return;

    const angleMin = getSliderVal("angle-min");
    const angleMax = getSliderVal("angle-max");
    const baseStrength = getSliderVal("base-strength");
    const maxStrength = getSliderVal("max-strength");

    const currentAngle = Math.max(0, Math.min(90, phoneBeta));
    let err = 0;

    if (currentAngle < angleMin) {
        err = angleMin - currentAngle;
    } else if (currentAngle > angleMax) {
        err = currentAngle - angleMax;
    }

    if (err > 0) {
        // 最大差值假定为 45 度
        const ratio = Math.min(1.0, err / 45);
        const strength = baseStrength + (maxStrength - baseStrength) * ratio;

        ws.send(JSON.stringify({
            "type": "game_pulse",
            "strength": Math.round(strength)
        }));

        navigator.vibrate && navigator.vibrate(50);
    }
}


// --- 7. 游戏 3: 摇骰子对决运行逻辑 ---

function initDiceGame() {
    isDiceShaking = false;
    document.getElementById("dice-1").innerText = "-";
    document.getElementById("dice-2").innerText = "-";
    document.getElementById("dice-3").innerText = "-";
    document.getElementById("dice-scores").innerText = "玩家总分: - | 对手总分: -";
    document.getElementById("dice-instruction").innerText = "摇晃手机 或 点击下方按钮开始摇号";
}

function triggerDiceShake() {
    const now = Date.now();
    if (!isDiceShaking) {
        // 开启摇晃
        isDiceShaking = true;
        document.getElementById("dice-instruction").innerText = "正在摇号...";
        document.getElementById("dice-1").innerText = "?";
        document.getElementById("dice-2").innerText = "?";
        document.getElementById("dice-3").innerText = "?";
    }

    // 1. 每 80ms 播放一次实时撞击摩擦音效，控制好音效频次
    if (now - lastShakeTime > 80) {
        playDiceCollisionSound();
        lastShakeTime = now;
    }

    // 2. 摇晃物理振动反馈
    if (now - lastVibrateTime > 120) {
        navigator.vibrate && navigator.vibrate(60);
        lastVibrateTime = now;
    }

    // 3. 摇晃静止超时防抖 (连续 800ms 没有剧烈晃动，视作摇晃结束)
    clearTimeout(shakeStopTimeout);
    shakeStopTimeout = setTimeout(settleDiceGame, 800);
}

function rollDicesManual() {
    // 解锁音频
    initAudio();
    if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume();
    }

    // 模拟一段连续摇晃效果
    isDiceShaking = true;
    let count = 0;
    const interval = setInterval(() => {
        playDiceCollisionSound();
        navigator.vibrate && navigator.vibrate(40);
        count++;
        if (count >= 10) {
            clearInterval(interval);
            settleDiceGame();
        }
    }, 100);
}

function settleDiceGame() {
    if (!isDiceShaking) return;
    isDiceShaking = false;

    // 1. 生成 3 个随机骰子点数
    const p1 = Math.floor(Math.random() * 6) + 1;
    const p2 = Math.floor(Math.random() * 6) + 1;
    const p3 = Math.floor(Math.random() * 6) + 1;
    const pTotal = p1 + p2 + p3;

    // 对手点数 (虚拟对手)
    const o1 = Math.floor(Math.random() * 6) + 1;
    const o2 = Math.floor(Math.random() * 6) + 1;
    const o3 = Math.floor(Math.random() * 6) + 1;
    const oTotal = o1 + o2 + o3;

    // 2. 展示 UI 读数
    document.getElementById("dice-1").innerText = p1;
    document.getElementById("dice-2").innerText = p2;
    document.getElementById("dice-3").innerText = p3;

    const scoresDiv = document.getElementById("dice-scores");
    scoresDiv.innerText = `玩家总分: ${pTotal} | 对手总分: ${oTotal}`;

    // 3. 计算对决结果
    const instructionDiv = document.getElementById("dice-instruction");
    if (pTotal >= oTotal) {
        instructionDiv.innerText = "挑战胜出 | 免于惩罚";
        instructionDiv.style.color = "#ffffff";
    } else {
        const diff = oTotal - pTotal; // 差额区间 1 - 15
        instructionDiv.innerText = `挑战失败 | 差额: ${diff}`;
        instructionDiv.style.color = "#ff3333";

        // 惩罚数据映射
        const baseStrength = getSliderVal("base-strength");
        const maxStrength = getSliderVal("max-strength");
        const timeMin = getSliderVal("dice-time-min");
        const timeMax = getSliderVal("dice-time-max");

        // 根据点数差值计算惩罚电击强度和时间
        const ratio = diff / 15.0; // 点数相差最多为 15 点 (如玩家 3 点, 对手 18 点)
        const punishStrength = baseStrength + (maxStrength - baseStrength) * ratio;
        const punishDuration = (timeMin + (timeMax - timeMin) * ratio) * 1000; // 转为毫秒

        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                "type": "game_shock_trigger",
                "strength": Math.round(punishStrength),
                "duration": Math.round(punishDuration)
            }));
        }

        // 手机端同步产生持续震动反馈
        navigator.vibrate && navigator.vibrate(punishDuration);
    }
}


// --- 8. 初始化入口 ---

window.onload = () => {
    connectWebSocket();
};
