(function (root, factory) {
    "use strict";

    const api = factory(
        root.CoyoteProtocol || (typeof require === "function" ? require("./coyote-protocol.js") : null),
        root.LiteWaveforms || (typeof require === "function" ? require("./waveforms.js") : null)
    );
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    }
    root.LiteOutputController = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function (protocol, waveforms) {
    "use strict";

    if (!protocol || !waveforms) {
        throw new Error("输出控制器缺少协议或波形模块");
    }

    const FRAME_INTERVAL_MS = 100;
    const MIN_PULSE_MS = 1000;
    const MAX_PULSE_MS = 60000;

    function clamp(value, minimum, maximum, fallback) {
        const number = Number(value);
        if (!Number.isFinite(number)) {
            return fallback;
        }
        return Math.min(maximum, Math.max(minimum, number));
    }

    class OutputController {
        constructor(driver, options) {
            if (!driver || typeof driver.writeFrame !== "function" || typeof driver.stop !== "function") {
                throw new TypeError("输出控制器需要有效的蓝牙驱动");
            }
            this.driver = driver;
            this.onStateChange = options && typeof options.onStateChange === "function"
                ? options.onStateChange
                : function () {};
            this.generation = 0;
            this.timer = null;
            this.timerResolve = null;
            this.runningPromise = null;
            this.desiredStrength = 0;
            this.config = {
                channel: "a",
                bStrengthMode: "percent",
                bStrengthPercent: 50,
                limitA: 30,
                limitB: 30,
                waveform: waveforms.DEFAULT_KEY
            };
        }

        configure(settings) {
            const next = settings || {};
            this.config = {
                channel: protocol.normalizeChannel(next.outputMode || next.channel),
                bStrengthMode: next.bStrengthMode === "same" ? "same" : "percent",
                bStrengthPercent: Math.round(clamp(next.bStrengthPercent, 10, 100, 50)),
                limitA: Math.round(clamp(next.limitA, 0, 200, 0)),
                limitB: Math.round(clamp(next.limitB, 0, 200, 0)),
                waveform: waveforms.normalizeKey(next.waveform)
            };
            return { ...this.config };
        }

        isRunning() {
            return Boolean(this.runningPromise);
        }

        async playPulse(strength, durationMs, source) {
            if (!this.driver.connected) {
                throw new Error("设备尚未连接");
            }
            const duration = Math.round(clamp(durationMs, MIN_PULSE_MS, MAX_PULSE_MS, MIN_PULSE_MS));
            const generation = await this._beginSession();
            const points = waveforms.fitPoints(this.config.waveform, duration);
            const safeStrength = Math.round(clamp(strength, 0, 200, 0));
            const deadline = Date.now() + duration;
            this._emit("输出中", source || "单次输出");
            this.runningPromise = this._runFinite(generation, safeStrength, points, deadline, source);
            return this.runningPromise;
        }

        async startContinuous(initialStrength, source) {
            if (!this.driver.connected) {
                throw new Error("设备尚未连接");
            }
            const generation = await this._beginSession();
            this.desiredStrength = Math.round(clamp(initialStrength, 0, 200, 0));
            // 连续模式每次进入时只解析一次随机波形，避免每 100ms 突变。
            const resolvedKey = waveforms.resolveKey(this.config.waveform, 60000);
            const points = waveforms.fitPoints(resolvedKey, 60000);
            this._emit(this.desiredStrength > 0 ? "输出中" : "等待判定", source || "连续输出");
            this.runningPromise = this._runContinuous(generation, points, source);
            return generation;
        }

        updateContinuous(strength, source) {
            if (!this.runningPromise) {
                return false;
            }
            this.desiredStrength = Math.round(clamp(strength, 0, 200, 0));
            this._emit(this.desiredStrength > 0 ? "输出中" : "等待判定", source || "连续输出");
            return true;
        }

        async stop(reason) {
            this.generation += 1;
            this.desiredStrength = 0;
            this._interruptDelay();
            this.runningPromise = null;
            try {
                await this.driver.stop();
            } finally {
                this._emit("已停止", reason || "用户停止");
            }
        }

        async emergencyStop(reason) {
            this.generation += 1;
            this.desiredStrength = 0;
            this._interruptDelay();
            this.runningPromise = null;
            try {
                await this.driver.stop();
            } catch (_error) {
                // 断连、锁屏或页面卸载时写零可能失败；仍需立即废止全部旧任务。
            }
            this._emit("已停止", reason || "安全停止");
        }

        async _beginSession() {
            this.generation += 1;
            const generation = this.generation;
            this.desiredStrength = 0;
            this._interruptDelay();
            this.runningPromise = null;
            await this.driver.stop();
            return generation;
        }

        async _runFinite(generation, strength, points, deadline, source) {
            try {
                for (let index = 0; index < points.length; index += 1) {
                    // 低速蓝牙写入不能把“1 秒”拖成数秒；到墙钟截止时间后不再补发旧帧。
                    if (generation !== this.generation) {
                        return false;
                    }
                    if (Date.now() >= deadline) {
                        break;
                    }
                    const startedAt = Date.now();
                    await this._write(strength, points[index]);
                    if (generation !== this.generation) {
                        return false;
                    }
                    if (Date.now() >= deadline) {
                        break;
                    }
                    await this._delay(Math.max(0, FRAME_INTERVAL_MS - (Date.now() - startedAt)));
                }
                if (generation === this.generation) {
                    await this.driver.stop();
                    this.runningPromise = null;
                    this._emit("间隔中", source || "单次输出完成");
                    return true;
                }
                return false;
            } catch (error) {
                if (generation === this.generation) {
                    await this.emergencyStop("输出异常");
                }
                throw error;
            }
        }

        async _runContinuous(generation, points, source) {
            let frameIndex = 0;
            try {
                while (generation === this.generation) {
                    const startedAt = Date.now();
                    await this._write(this.desiredStrength, points[frameIndex % points.length]);
                    frameIndex += 1;
                    if (generation !== this.generation) {
                        return false;
                    }
                    await this._delay(Math.max(0, FRAME_INTERVAL_MS - (Date.now() - startedAt)));
                }
                return false;
            } catch (error) {
                if (generation === this.generation) {
                    await this.emergencyStop("连续输出异常");
                }
                throw error;
            } finally {
                if (generation === this.generation) {
                    this.runningPromise = null;
                    this._emit("已停止", source || "连续输出结束");
                }
            }
        }

        async _write(strength, point) {
            const strengths = protocol.channelStrengths(
                strength,
                this.config.channel,
                this.config.limitA,
                this.config.limitB,
                this.config.bStrengthMode,
                this.config.bStrengthPercent
            );
            await this.driver.writeFrame({
                strengthA: strengths.a,
                strengthB: strengths.b,
                point
            });
        }

        _delay(milliseconds) {
            return new Promise((resolve) => {
                this.timerResolve = resolve;
                this.timer = setTimeout(() => {
                    this.timer = null;
                    this.timerResolve = null;
                    resolve();
                }, milliseconds);
            });
        }

        _interruptDelay() {
            if (this.timer !== null) {
                clearTimeout(this.timer);
                this.timer = null;
            }
            if (this.timerResolve) {
                const resolve = this.timerResolve;
                this.timerResolve = null;
                resolve();
            }
        }

        _emit(stage, detail) {
            this.onStateChange({ stage, detail, strength: this.desiredStrength });
        }
    }

    return Object.freeze({
        FRAME_INTERVAL_MS,
        MAX_PULSE_MS,
        MIN_PULSE_MS,
        OutputController
    });
}));
