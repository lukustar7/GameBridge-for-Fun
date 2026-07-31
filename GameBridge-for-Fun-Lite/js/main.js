/* GameBridge-for-Fun-Lite 主控逻辑
   集成 WebBluetooth 驱动、安全熔断引擎、PWA 管理器与 5 款小游戏物理渲染
*/

document.addEventListener('DOMContentLoaded', async () => {

  // 1. 初始化核心实例
  const bleDriver = new CoyoteBLEDriver();
  const safetyGuard = new SafetyGuard(bleDriver);
  const pwaManager = new PWAManager();

  // 2. 获取 UI 节点
  const splashScreen = document.getElementById('splash-screen');
  const splashProgressInner = document.getElementById('splash-progress-inner');
  const splashStatusText = document.getElementById('splash-status-text');

  const envWarningModal = document.getElementById('env-warning-modal');
  const modalTitle = document.getElementById('modal-title');
  const modalDesc = document.getElementById('modal-desc');
  const modalBtnConfirm = document.getElementById('modal-btn-confirm');

  const deviceStateTag = document.getElementById('device-state-tag');
  const btnEmergencyStop = document.getElementById('btn-emergency-stop');

  const btnConnectBle = document.getElementById('btn-connect-ble');
  const btnIdentifyBle = document.getElementById('btn-identify-ble');
  const bleDeviceDetail = document.getElementById('ble-device-detail');
  const txtDeviceName = document.getElementById('txt-device-name');
  const txtDeviceType = document.getElementById('txt-device-type');

  const txtLimitA = document.getElementById('txt-limit-a');
  const txtLimitB = document.getElementById('txt-limit-b');
  const sliderLimitA = document.getElementById('slider-limit-a');
  const sliderLimitB = document.getElementById('slider-limit-b');

  const gameCards = document.querySelectorAll('.game-card');
  const txtCurrentGameTitle = document.getElementById('txt-current-game-title');
  const txtGameStatus = document.getElementById('txt-game-status');
  const canvas = document.getElementById('game-canvas');
  const ctx = canvas.getContext('2d');
  const btnGameAction = document.getElementById('btn-game-action');

  const updateToast = document.getElementById('update-toast');
  const btnUpdateNow = document.getElementById('btn-update-now');
  const btnUpdateLater = document.getElementById('btn-update-later');

  // 当前激活的游戏状态
  let activeGame = 'shake'; // 'shake', 'angle', 'dice', 'slot', 'lightning'
  let isGameRunning = false;
  let animationFrameId = null;

  // 传感器数据
  let tiltBeta = 0;  // 前后倾斜
  let tiltGamma = 0; // 左右倾斜
  let ballX = 0;
  let ballY = 0;
  let ballVx = 0;
  let ballVy = 0;

  // 3. 启动 Splash 自检流程
  async function runSplashCheck() {
    splashProgressInner.style.width = '30%';
    splashStatusText.innerText = '自检 PWA 离线服务...';
    
    // 初始化 PWA
    await pwaManager.init();
    pwaManager.onUpdateFound(() => {
      updateToast.classList.remove('hidden');
    });

    splashProgressInner.style.width = '70%';
    splashStatusText.innerText = '自检 WebBluetooth 硬件能力...';

    // 检查蓝牙支持
    if (!CoyoteBLEDriver.isSupported()) {
      splashProgressInner.style.width = '100%';
      setTimeout(() => {
        splashScreen.classList.add('hidden');
        showEnvWarning(
          '网页蓝牙接口受限',
          '当前浏览器不支持 WebBluetooth。如果您使用的是 iPhone (iOS)，请在 App Store 免费下载 Blueify 或 WebBLE 浏览器打开本网页。'
        );
      }, 500);
      return;
    }

    splashProgressInner.style.width = '100%';
    splashStatusText.innerText = '自检完成，就绪';
    setTimeout(() => {
      splashScreen.classList.add('hidden');
    }, 400);
  }

  function showEnvWarning(title, desc) {
    modalTitle.innerText = title;
    modalDesc.innerText = desc;
    envWarningModal.classList.remove('hidden');
  }

  modalBtnConfirm.addEventListener('click', () => {
    envWarningModal.classList.add('hidden');
  });

  // PWA 更新交互
  btnUpdateNow.addEventListener('click', () => {
    pwaManager.applyUpdate();
  });
  btnUpdateLater.addEventListener('click', () => {
    updateToast.classList.add('hidden');
  });

  // 4. 蓝牙驱动状态与 UI 绑定
  bleDriver.onStatusChange(({ connected, statusText, deviceType, deviceName }) => {
    deviceStateTag.innerText = statusText;
    if (connected) {
      deviceStateTag.className = 'device-state-tag connected';
      btnConnectBle.innerText = '重新连接 / 切换';
      btnIdentifyBle.classList.remove('hidden');
      bleDeviceDetail.classList.remove('hidden');
      txtDeviceName.innerText = deviceName;
      txtDeviceType.innerText = deviceType === 'COYOTE_020' ? '郊狼 2.0 (3字节)' : '郊狼 3.0 (V3八字节)';
    } else {
      deviceStateTag.className = 'device-state-tag disconnected';
      btnConnectBle.innerText = '搜索并连接郊狼';
      btnIdentifyBle.classList.add('hidden');
      bleDeviceDetail.classList.add('hidden');
    }
  });

  btnConnectBle.addEventListener('click', async () => {
    try {
      await bleDriver.requestAndConnect();
    } catch (err) {
      console.warn('蓝牙请求取消或失败:', err);
    }
  });

  btnIdentifyBle.addEventListener('click', async () => {
    await bleDriver.triggerPhysicsIdentify();
  });

  // 紧急停止
  btnEmergencyStop.addEventListener('click', async () => {
    stopActiveGame();
    await safetyGuard.emergencyStop();
    txtGameStatus.innerText = '已被急停断开';
    txtGameStatus.style.color = 'var(--accent-red)';
  });

  // 限幅滑块绑定
  sliderLimitA.addEventListener('input', (e) => {
    txtLimitA.innerText = e.target.value;
    safetyGuard.setLimits(sliderLimitA.value, sliderLimitB.value);
  });
  sliderLimitB.addEventListener('input', (e) => {
    txtLimitB.innerText = e.target.value;
    safetyGuard.setLimits(sliderLimitA.value, sliderLimitB.value);
  });

  // 5. 姿态传感器监听 (DeviceOrientation)
  if (window.DeviceOrientationEvent) {
    window.addEventListener('deviceorientation', (e) => {
      if (e.beta !== null && e.gamma !== null) {
        tiltBeta = e.beta;   // -180 ~ 180 (前后)
        tiltGamma = e.gamma; // -90 ~ 90 (左右)
      }
    });
  }

  // 6. 画布自适应重绘
  function resizeCanvas() {
    canvas.width = canvas.parentElement.clientWidth;
    canvas.height = canvas.parentElement.clientHeight;
    ballX = canvas.width / 2;
    ballY = canvas.height / 2;
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  // 7. 游戏选择与主循环
  gameCards.forEach((card) => {
    card.addEventListener('click', () => {
      if (isGameRunning) stopActiveGame();
      gameCards.forEach((c) => c.classList.remove('active'));
      card.classList.add('active');
      activeGame = card.dataset.game;

      const titles = {
        shake: '手抖挑战',
        angle: '保持角度',
        dice: '摇骰子对决',
        slot: '极速角子机',
        lightning: '雷电极速 (GPS)'
      };
      txtCurrentGameTitle.innerText = titles[activeGame];
      txtGameStatus.innerText = '准备就绪';
      txtGameStatus.style.color = 'var(--accent-cyan)';
    });
  });

  btnGameAction.addEventListener('click', () => {
    if (isGameRunning) {
      stopActiveGame();
    } else {
      startGame();
    }
  });

  function startGame() {
    isGameRunning = true;
    btnGameAction.innerText = '停止游戏';
    btnGameAction.className = 'btn-secondary';
    txtGameStatus.innerText = '进行中...';
    txtGameStatus.style.color = 'var(--accent-green)';

    if (activeGame === 'shake') {
      runShakeGameLoop();
    } else if (activeGame === 'angle') {
      runAngleGameLoop();
    } else if (activeGame === 'dice') {
      runDiceGame();
    } else if (activeGame === 'slot') {
      runSlotGame();
    } else if (activeGame === 'lightning') {
      runLightningGame();
    }
  }

  function stopActiveGame() {
    isGameRunning = false;
    btnGameAction.innerText = '开始游戏';
    btnGameAction.className = 'btn-primary';
    txtGameStatus.innerText = '已暂停';
    txtGameStatus.style.color = 'var(--text-sub)';

    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
    // 游戏结束自动发送归零数据
    safetyGuard.safeSendPulse(0, 0, 100);
  }

  // ---- 游戏 1: 手抖挑战 (倾角弹珠) ----
  function runShakeGameLoop() {
    if (!isGameRunning) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const safeRadius = Math.min(canvas.width, canvas.height) * 0.35;

    // 根据倾角计算物理加速度
    ballVx += (tiltGamma / 90) * 0.4;
    ballVy += (tiltBeta / 90) * 0.4;
    ballVx *= 0.92; // 阻尼
    ballVy *= 0.92;
    ballX += ballVx;
    ballY += ballVy;

    // 画安全圈
    ctx.beginPath();
    ctx.arc(centerX, centerY, safeRadius, 0, Math.PI * 2);
    ctx.strokeStyle = '#222228';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 绘制弹珠
    ctx.beginPath();
    ctx.arc(ballX, ballY, 8, 0, Math.PI * 2);
    ctx.fillStyle = 'var(--accent-cyan)';
    ctx.fill();

    // 判定出界
    const dist = Math.hypot(ballX - centerX, ballY - centerY);
    if (dist > safeRadius) {
      // 偏离越远惩罚越大
      const offset = dist - safeRadius;
      const calcStrength = Math.min(100, Math.floor(offset * 1.5));
      safetyGuard.safeSendPulse(calcStrength, calcStrength, 100);
      
      ctx.strokeStyle = 'var(--accent-red)';
      ctx.stroke();
    }

    animationFrameId = requestAnimationFrame(runShakeGameLoop);
  }

  // ---- 游戏 2: 保持角度 ----
  function runAngleGameLoop() {
    if (!isGameRunning) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;

    const currentAngle = Math.round(tiltBeta);
    const targetMin = 20;
    const targetMax = 50;

    // 绘制表盘背景
    ctx.fillStyle = '#111116';
    ctx.fillRect(20, centerY - 20, canvas.width - 40, 40);

    // 绘制安全目标区
    const targetX1 = 20 + ((targetMin + 90) / 180) * (canvas.width - 40);
    const targetX2 = 20 + ((targetMax + 90) / 180) * (canvas.width - 40);
    ctx.fillStyle = 'rgba(0, 255, 102, 0.2)';
    ctx.fillRect(targetX1, centerY - 20, targetX2 - targetX1, 40);

    // 绘制指针位置
    const pointerX = 20 + ((currentAngle + 90) / 180) * (canvas.width - 40);
    ctx.fillStyle = 'var(--accent-cyan)';
    ctx.fillRect(pointerX - 2, centerY - 30, 4, 60);

    // 文字标注
    ctx.fillStyle = 'var(--text-main)';
    ctx.font = '14px monospace';
    ctx.fillText(`当前角度: ${currentAngle}° (目标: ${targetMin}°~${targetMax}°)`, 20, 40);

    // 出界判定
    if (currentAngle < targetMin || currentAngle > targetMax) {
      const diff = currentAngle < targetMin ? (targetMin - currentAngle) : (currentAngle - targetMax);
      const calcStrength = Math.min(100, diff * 2);
      safetyGuard.safeSendPulse(calcStrength, calcStrength, 100);
    }

    animationFrameId = requestAnimationFrame(runAngleGameLoop);
  }

  // ---- 游戏 3: 摇骰子对决 ----
  function runDiceGame() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'var(--text-main)';
    ctx.font = '16px monospace';
    ctx.fillText('摇晃手机投掷 3 颗骰子...', 30, 100);

    // 模拟投掷结算 (复用 GameLogic)
    setTimeout(() => {
      if (!isGameRunning) return;
      const playerDice = [Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1];
      const opponentDice = [Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1];
      const pSum = playerDice.reduce((a,b)=>a+b,0);
      const oSum = opponentDice.reduce((a,b)=>a+b,0);

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillText(`你的点数: ${playerDice.join(', ')} (总分 ${pSum})`, 30, 80);
      ctx.fillText(`对手点数: ${opponentDice.join(', ')} (总分 ${oSum})`, 30, 120);

      if (pSum < oSum) {
        const diff = oSum - pSum;
        ctx.fillStyle = 'var(--accent-red)';
        ctx.fillText(`判定: 点数落后 ${diff} 点！触发惩罚`, 30, 160);
        safetyGuard.safeSendPulse(diff * 5, diff * 5, 1000);
      } else {
        ctx.fillStyle = 'var(--accent-green)';
        ctx.fillText(`判定: 获胜！无惩罚`, 30, 160);
      }
      stopActiveGame();
    }, 1500);
  }

  // ---- 游戏 4: 极速角子机 ----
  function runSlotGame() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'var(--text-main)';
    ctx.font = '16px monospace';
    ctx.fillText('转盘旋转中...', 30, 100);

    setTimeout(() => {
      if (!isGameRunning) return;
      const symbols = ['💎', '🔔', '🍀', '7️⃣'];
      const r1 = symbols[Math.floor(Math.random()*symbols.length)];
      const r2 = symbols[Math.floor(Math.random()*symbols.length)];
      const r3 = symbols[Math.floor(Math.random()*symbols.length)];

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.font = '32px sans-serif';
      ctx.fillText(`${r1}  ${r2}  ${r3}`, 50, 100);

      ctx.font = '14px monospace';
      if (r1 === r2 && r2 === r3) {
        ctx.fillStyle = 'var(--accent-green)';
        ctx.fillText('判定: 大奖！清空连败与惩罚', 30, 160);
      } else {
        ctx.fillStyle = 'var(--accent-red)';
        ctx.fillText('判定: 未中奖，输出中等惩罚', 30, 160);
        safetyGuard.safeSendPulse(25, 25, 1200);
      }
      stopActiveGame();
    }, 1200);
  }

  // ---- 游戏 5: 雷电极速 (GPS) ----
  function runLightningGame() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'var(--text-main)';
    ctx.font = '14px monospace';

    if (!('geolocation' in navigator)) {
      ctx.fillStyle = 'var(--accent-red)';
      ctx.fillText('当前设备不支持 GPS 定位', 30, 100);
      stopActiveGame();
      return;
    }

    ctx.fillText('正在获取真实车速定位 (GPS)...', 30, 100);

    const watchId = navigator.geolocation.watchPosition((pos) => {
      if (!isGameRunning) return;
      const speedKmH = pos.coords.speed ? (pos.coords.speed * 3.6) : 0;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = 'var(--accent-cyan)';
      ctx.font = '24px monospace';
      ctx.fillText(`实时车速: ${speedKmH.toFixed(1)} km/h`, 30, 80);

      if (speedKmH > 60) {
        // 超速安全自动熔断
        ctx.fillStyle = 'var(--accent-red)';
        ctx.font = '14px monospace';
        ctx.fillText('警告: 超速熔断！强行切断输出', 30, 120);
        safetyGuard.safeSendPulse(0, 0, 100);
      } else if (speedKmH > 10) {
        const calcStrength = Math.min(80, Math.floor(speedKmH * 1.2));
        ctx.fillStyle = 'var(--accent-green)';
        ctx.font = '14px monospace';
        ctx.fillText(`动态输出强度: ${calcStrength}`, 30, 120);
        safetyGuard.safeSendPulse(calcStrength, calcStrength, 200);
      }
    }, (err) => {
      console.warn('GPS 错误:', err);
    }, { enableHighAccuracy: true });

    // 保存取消句柄
    canvas.dataset.watchId = watchId;
  }

  // 8. 启动自检
  runSplashCheck();
});
