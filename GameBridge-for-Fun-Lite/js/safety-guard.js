/* GameBridge-for-Fun-Lite 底层安全熔断引擎
   实现出口硬限幅卡死与 0.1s 自动到期停电归零保护
*/

class SafetyGuard {
  constructor(bleDriver) {
    this.bleDriver = bleDriver;
    this.limitA = 30; // A 通道安全限幅（默认 30，最高 200）
    this.limitB = 30; // B 通道安全限幅（默认 30，最高 200）
    this.watchdogTimer = null;
    this.lastPulseTimestamp = 0;
    this.EXPIRING_TIMEOUT_MS = 150; // 0.15 秒无续报自动熔断归零
  }

  // 设置安全软上限
  setLimits(limitA, limitB) {
    this.limitA = Math.min(200, Math.max(0, parseInt(limitA) || 0));
    this.limitB = Math.min(200, Math.max(0, parseInt(limitB) || 0));
  }

  // 第一重防线：出口数学硬限幅卡死
  clampStrength(channel, rawStrength) {
    const parsed = Math.max(0, Math.floor(rawStrength || 0));
    const limit = (channel === 'A' || channel === 'a') ? this.limitA : this.limitB;
    // 强制卡死在用户设置的安全限幅和协议上限 200 之间
    return Math.min(parsed, limit, 200);
  }

  // 安全下发接口：任何传入的数值都会被硬卡死，并激活自动到期看门狗
  async safeSendPulse(rawStrengthA, rawStrengthB, durationMs = 100) {
    const safeA = this.clampStrength('A', rawStrengthA);
    const safeB = this.clampStrength('B', rawStrengthB);

    this.lastPulseTimestamp = Date.now();
    this._resetWatchdog();

    // 真正下发给蓝牙
    return await this.bleDriver.sendPulse(safeA, safeB, durationMs);
  }

  // 第二重防线：0.15秒到期断电熔断器
  _resetWatchdog() {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
    }
    this.watchdogTimer = setTimeout(() => {
      this._triggerEmergencyCutoff('自动到期看门狗熔断 (无脉冲续报)');
    }, this.EXPIRING_TIMEOUT_MS);
  }

  // 第三重防线：物理紧急归零断电
  async _triggerEmergencyCutoff(reason = '紧急归零') {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    console.warn(`[SafetyGuard] ${reason}`);
    // 发送归零数据包
    await this.bleDriver.sendPulse(0, 0, 100);
  }

  // 一键硬急停入口
  async emergencyStop() {
    await this._triggerEmergencyCutoff('用户按下了紧急停止');
    this.bleDriver.disconnect();
  }
}
