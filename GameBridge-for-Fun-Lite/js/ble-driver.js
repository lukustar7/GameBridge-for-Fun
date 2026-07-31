(function (root, factory) {
    "use strict";

    const api = factory(root.CoyoteProtocol || (typeof require === "function" ? require("./coyote-protocol.js") : null));
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    }
    root.LiteBleDriver = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function (protocol) {
    "use strict";

    if (!protocol) {
        throw new Error("蓝牙驱动缺少协议模块");
    }

    async function writeCharacteristic(characteristic, bytes) {
        if (!characteristic) {
            throw new Error("设备缺少必要的蓝牙特征");
        }
        if (typeof characteristic.writeValueWithoutResponse === "function") {
            await characteristic.writeValueWithoutResponse(bytes);
            return;
        }
        if (typeof characteristic.writeValue === "function") {
            await characteristic.writeValue(bytes);
            return;
        }
        throw new Error("当前浏览器不支持蓝牙写入");
    }

    class BleDriver {
        constructor(options) {
            const callbacks = options || {};
            this.onStatus = typeof callbacks.onStatus === "function" ? callbacks.onStatus : function () {};
            this.onActualStrength = typeof callbacks.onActualStrength === "function"
                ? callbacks.onActualStrength
                : function () {};
            this.device = null;
            this.server = null;
            this.protocolVersion = null;
            this.characteristics = {};
            this.connected = false;
            this.sequence = 0;
            this.queue = Promise.resolve();
            this._boundDisconnect = this._handleDisconnect.bind(this);
            this._boundNotification = this._handleNotification.bind(this);
        }

        static isSupported(navigatorObject) {
            const candidate = navigatorObject || (typeof navigator !== "undefined" ? navigator : null);
            return Boolean(candidate && candidate.bluetooth && typeof candidate.bluetooth.requestDevice === "function");
        }

        async connect(navigatorObject) {
            const candidate = navigatorObject || (typeof navigator !== "undefined" ? navigator : null);
            if (!BleDriver.isSupported(candidate)) {
                throw new Error("当前浏览器没有 Web Bluetooth，无法直接连接设备");
            }

            await this.disconnect();
            this.onStatus({ state: "connecting", message: "正在选择并识别设备" });
            try {
                this.device = await candidate.bluetooth.requestDevice({
                    filters: [
                        { services: [protocol.UUIDS.v3.service] },
                        { services: [protocol.UUIDS.v2.service] },
                        { namePrefix: "47L121000" },
                        { namePrefix: "D-LAB ESTIM01" }
                    ],
                    optionalServices: [protocol.UUIDS.v2.service, protocol.UUIDS.v3.service]
                });
                this.device.addEventListener("gattserverdisconnected", this._boundDisconnect);
                this.server = await this.device.gatt.connect();
                await this._discoverProtocol();
                this.connected = true;
                await this.stop();
                this.onStatus({
                    state: "connected",
                    message: `${this.device.name || "已选设备"} · ${this.protocolVersion}`,
                    protocol: this.protocolVersion
                });
                return {
                    name: this.device.name || "未命名设备",
                    protocol: this.protocolVersion
                };
            } catch (error) {
                const failedDevice = this.device;
                this._resetConnection(false);
                if (failedDevice && failedDevice.gatt && failedDevice.gatt.connected) {
                    failedDevice.gatt.disconnect();
                }
                this.onStatus({ state: "error", message: error.message || "蓝牙连接失败" });
                throw error;
            }
        }

        async disconnect() {
            if (this.connected) {
                try {
                    await this.stop();
                } catch (_error) {
                    // 断开动作以切断连接为主，设备已经离线时无需阻塞。
                }
            }
            const device = this.device;
            this._resetConnection(false);
            if (device && device.gatt && device.gatt.connected) {
                device.gatt.disconnect();
            }
            this.onStatus({ state: "disconnected", message: "尚未连接设备" });
        }

        async writeFrame(frame) {
            if (!this.connected || !this.protocolVersion) {
                throw new Error("蓝牙连接已断开");
            }
            const payload = frame || {};
            const strengthA = Math.round(Number(payload.strengthA) || 0);
            const strengthB = Math.round(Number(payload.strengthB) || 0);
            const point = Array.isArray(payload.point) ? payload.point : [10, 0];
            return this._enqueue(async () => {
                if (!this.connected) {
                    throw new Error("蓝牙连接已断开");
                }
                if (this.protocolVersion === "3.0") {
                    const bytes = protocol.encodeV3Frame({
                        sequence: this.sequence,
                        mode: 0x0f,
                        strengthA,
                        strengthB,
                        point
                    });
                    this.sequence = (this.sequence + 1) & 0x0f;
                    await writeCharacteristic(this.characteristics.write, bytes);
                    return;
                }
                await writeCharacteristic(
                    this.characteristics.strength,
                    protocol.encodeV2Strength(strengthA, strengthB)
                );
                await writeCharacteristic(this.characteristics.waveA, protocol.encodeV2WavePoint(point));
                await writeCharacteristic(this.characteristics.waveB, protocol.encodeV2WavePoint(point));
            });
        }

        async stop() {
            if (!this.connected || !this.protocolVersion) {
                return;
            }
            return this._enqueue(async () => {
                if (!this.connected) {
                    return;
                }
                if (this.protocolVersion === "3.0") {
                    const zero = protocol.encodeV3Frame({
                        sequence: this.sequence,
                        mode: 0x0f,
                        strengthA: 0,
                        strengthB: 0,
                        point: [10, 0]
                    });
                    this.sequence = (this.sequence + 1) & 0x0f;
                    await writeCharacteristic(this.characteristics.write, zero);
                    return;
                }
                await writeCharacteristic(this.characteristics.strength, protocol.encodeV2Strength(0, 0));
                const zeroWave = protocol.encodeV2WavePoint([10, 0]);
                await writeCharacteristic(this.characteristics.waveA, zeroWave);
                await writeCharacteristic(this.characteristics.waveB, zeroWave);
            });
        }

        async _discoverProtocol() {
            let service = null;
            try {
                service = await this.server.getPrimaryService(protocol.UUIDS.v3.service);
            } catch (_error) {
                service = null;
            }
            if (service) {
                this.protocolVersion = "3.0";
                this.characteristics.write = await service.getCharacteristic(protocol.UUIDS.v3.write);
                try {
                    this.characteristics.notify = await service.getCharacteristic(protocol.UUIDS.v3.notify);
                    await this.characteristics.notify.startNotifications();
                    this.characteristics.notify.addEventListener("characteristicvaluechanged", this._boundNotification);
                } catch (_error) {
                    // 通知只用于显示设备实际强度，缺失时不影响停止和输出控制。
                    this.characteristics.notify = null;
                }
                return;
            }

            try {
                service = await this.server.getPrimaryService(protocol.UUIDS.v2.service);
            } catch (_error) {
                service = null;
            }
            if (!service) {
                throw new Error("所选设备不是已支持的 2.0 或 3.0 型号");
            }
            this.protocolVersion = "2.0";
            this.characteristics.strength = await service.getCharacteristic(protocol.UUIDS.v2.strength);
            this.characteristics.waveA = await service.getCharacteristic(protocol.UUIDS.v2.waveA);
            this.characteristics.waveB = await service.getCharacteristic(protocol.UUIDS.v2.waveB);
        }

        _enqueue(task) {
            const next = this.queue.catch(function () {}).then(task);
            this.queue = next;
            return next;
        }

        _handleNotification(event) {
            const parsed = protocol.parseV3Notification(event.target.value);
            if (parsed) {
                this.onActualStrength(parsed);
            }
        }

        _handleDisconnect() {
            this._resetConnection(true);
            this.onStatus({ state: "disconnected", message: "设备连接已断开，输出任务已作废" });
        }

        _resetConnection(preserveDevice) {
            if (this.characteristics.notify) {
                this.characteristics.notify.removeEventListener("characteristicvaluechanged", this._boundNotification);
            }
            if (this.device) {
                this.device.removeEventListener("gattserverdisconnected", this._boundDisconnect);
            }
            this.connected = false;
            this.server = null;
            this.protocolVersion = null;
            this.characteristics = {};
            this.sequence = 0;
            this.queue = Promise.resolve();
            if (!preserveDevice) {
                this.device = null;
            }
        }
    }

    return Object.freeze({ BleDriver, writeCharacteristic });
}));
