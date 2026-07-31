/* GameBridge-for-Fun-Lite WebBluetooth 原生驱动
   支持郊狼 2.0 (3字节小端) 与 郊狼 3.0 (8字节V3波形) 直连
*/

class CoyoteBLEDriver {
  constructor() {
    this.device = null;
    this.server = null;
    this.rxCharacteristic = null;
    this.deviceType = 'COYOTE_030'; // 默认 3.0，握手后按 UUID / 广播名自动区分
    this.deviceName = '';
    this.isConnected = false;
    this.onStatusChangeCallback = null;

    // 官方协议 UUID 常量
    this.SERVICE_UUID_V3 = '955a0001-0925-423a-ab0a-80b1e19b2a07';
    this.CHAR_UUID_V3 = '955a0002-0925-423a-ab0a-80b1e19b2a07';
    
    this.SERVICE_UUID_V2 = '0000180c-0000-1000-8000-00805f9b34fb';
    this.CHAR_UUID_V2 = '00002a56-0000-1000-8000-00805f9b34fb';
  }

  // 设置状态变化回调
  onStatusChange(fn) {
    this.onStatusChangeCallback = fn;
  }

  _notifyStatus(statusText, connected = false) {
    this.isConnected = connected;
    if (this.onStatusChangeCallback) {
      this.onStatusChangeCallback({
        connected,
        statusText,
        deviceType: this.deviceType,
        deviceName: this.deviceName
      });
    }
  }

  // 检查浏览器是否具备 WebBluetooth 硬件接口
  static isSupported() {
    return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
  }

  // 请求弹出系统蓝牙选择器弹窗并建立连接
  async requestAndConnect() {
    if (!CoyoteBLEDriver.isSupported()) {
      throw new Error('当前浏览器不支持网页蓝牙 (WebBluetooth)');
    }

    try {
      this._notifyStatus('正在扫描蓝牙设备...', false);

      // 请求弹出蓝牙挑选框（兼容 2.0 与 3.0 服务广播）
      this.device = await navigator.bluetooth.requestDevice({
        filters: [
          { namePrefix: 'DG-LAB' },
          { namePrefix: 'DungeonLab' },
          { namePrefix: 'Coyote' }
        ],
        optionalServices: [this.SERVICE_UUID_V3, this.SERVICE_UUID_V2]
      });

      if (!this.device) {
        throw new Error('未选择任何设备');
      }

      this.deviceName = this.device.name || 'Coyote Device';
      
      // 按设备名称判断型号
      if (this.deviceName.includes('2.0') || this.deviceName.includes('COYOTE_020')) {
        this.deviceType = 'COYOTE_020';
      } else {
        this.deviceType = 'COYOTE_030';
      }

      // 监听物理断开事件
      this.device.addEventListener('gattserverdisconnected', () => {
        this._notifyStatus('蓝牙已断开', false);
      });

      this._notifyStatus('正在建立 GATT 连接...', false);
      this.server = await this.device.gatt.connect();

      // 获取服务与写入特征
      if (this.deviceType === 'COYOTE_020') {
        const service = await this.server.getPrimaryService(this.SERVICE_UUID_V2);
        this.rxCharacteristic = await service.getCharacteristic(this.CHAR_UUID_V2);
      } else {
        const service = await this.server.getPrimaryService(this.SERVICE_UUID_V3);
        this.rxCharacteristic = await service.getCharacteristic(this.CHAR_UUID_V3);
      }

      // 连接成功，记忆设备标识
      localStorage.setItem('gb_lite_last_device_id', this.device.id);
      this._notifyStatus(`已连接: ${this.deviceName}`, true);
      return true;

    } catch (err) {
      this._notifyStatus(`连接失败: ${err.message}`, false);
      throw err;
    }
  }

  // 下发脉冲控制数据
  async sendPulse(channelAStrength, channelBStrength, durationMs = 100) {
    if (!this.isConnected || !this.rxCharacteristic) {
      return false;
    }

    try {
      let payload;
      if (this.deviceType === 'COYOTE_020') {
        // 二代 3 字节小端编解码：X(5bit脉宽), Y(10bit间隔), Z(9bit强度)
        // 强度转换：2.0 协议强度为设备强度除以 5 (0~20)
        const waveZ = Math.min(20, Math.floor(channelAStrength / 5));
        const pulseX = 5;
        const pauseY = 95; // 组装为 100Hz 帧
        const packed = (pulseX & 0x1F) | ((pauseY & 0x3FF) << 5) | ((waveZ & 0x1FF) << 15);
        payload = new Uint8Array([
          packed & 0xFF,
          (packed >> 8) & 0xFF,
          (packed >> 16) & 0xFF
        ]);
      } else {
        // 三代 8 字节波形序列（100Hz 频率帧）
        const stA = Math.min(200, Math.max(0, channelAStrength));
        const stB = Math.min(200, Math.max(0, channelBStrength));
        payload = new Uint8Array([100, 100, 100, 100, stA, stA, stB, stB]);
      }

      await this.rxCharacteristic.writeValueWithoutResponse(payload);
      return true;
    } catch (e) {
      console.warn('蓝牙下发失败:', e);
      return false;
    }
  }

  // 物理微弱震动试电确认（确认连对实体设备）
  async triggerPhysicsIdentify() {
    if (!this.isConnected) return;
    // 下发 0.2 秒强度 15 的安全微弱测试脉冲
    await this.sendPulse(15, 15, 200);
    setTimeout(async () => {
      await this.sendPulse(0, 0, 100);
    }, 200);
  }

  // 断开蓝牙连接
  disconnect() {
    if (this.device && this.device.gatt.connected) {
      // 断开前发送清零包
      this.sendPulse(0, 0, 100).finally(() => {
        this.device.gatt.disconnect();
        this._notifyStatus('已断开连接', false);
      });
    }
  }
}
