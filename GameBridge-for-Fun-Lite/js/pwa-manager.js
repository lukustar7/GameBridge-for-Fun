/* GameBridge-for-Fun-Lite PWA Manager
   负责离线缓存注册、资源完整性检测与版本更新平滑提醒
*/

class PWAManager {
  constructor() {
    this.swRegistration = null;
    this.onUpdateFoundCallback = null;
  }

  // 监听新版本更新回调
  onUpdateFound(fn) {
    this.onUpdateFoundCallback = fn;
  }

  // 初始化 Service Worker 注册与自检
  async init() {
    if ('serviceWorker' in navigator) {
      try {
        this.swRegistration = await navigator.serviceWorker.register('./sw.js');
        console.log('[PWA] Service Worker 注册成功:', this.swRegistration.scope);

        // 监听版本更新事件
        this.swRegistration.addEventListener('updatefound', () => {
          const newWorker = this.swRegistration.installing;
          if (newWorker) {
            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                // 后台成功下载新版本资源，向用户弹窗提醒
                if (this.onUpdateFoundCallback) {
                  this.onUpdateFoundCallback();
                }
              }
            });
          }
        });
      } catch (err) {
        console.warn('[PWA] Service Worker 注册失败:', err);
      }
    }
  }

  // 用户点击 [立即更新] 时激活新版本 Service Worker
  applyUpdate() {
    if (this.swRegistration && this.swRegistration.waiting) {
      this.swRegistration.waiting.postMessage({ action: 'skipWaiting' });
    }
    window.location.reload();
  }

  // 检查是否处于 PWA 独立全屏运行模式
  static isPWA() {
    return (window.matchMedia('(display-mode: standalone)').matches) || (window.navigator.standalone === true);
  }
}
