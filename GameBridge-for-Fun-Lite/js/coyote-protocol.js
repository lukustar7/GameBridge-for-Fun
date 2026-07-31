(function (root, factory) {
    "use strict";

    const api = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    }
    root.CoyoteProtocol = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const UUIDS = Object.freeze({
        v2: Object.freeze({
            service: "955a180b-0fe2-f5aa-a094-84b8d4f3e8ad",
            strength: "955a1504-0fe2-f5aa-a094-84b8d4f3e8ad",
            waveA: "955a1505-0fe2-f5aa-a094-84b8d4f3e8ad",
            waveB: "955a1506-0fe2-f5aa-a094-84b8d4f3e8ad"
        }),
        v3: Object.freeze({
            service: "0000180c-0000-1000-8000-00805f9b34fb",
            write: "0000150a-0000-1000-8000-00805f9b34fb",
            notify: "0000150b-0000-1000-8000-00805f9b34fb"
        })
    });

    function clampNumber(value, minimum, maximum, fallback) {
        const number = Number(value);
        if (!Number.isFinite(number)) {
            return fallback;
        }
        return Math.min(maximum, Math.max(minimum, number));
    }

    function normalizeChannel(value) {
        return ["a", "b", "ab"].includes(value) ? value : "a";
    }

    function channelStrengths(strength, channel, limitA, limitB, bStrengthMode, bStrengthPercent) {
        const safeStrength = Math.round(clampNumber(strength, 0, 200, 0));
        const safeA = Math.round(clampNumber(limitA, 0, 200, 0));
        const safeB = Math.round(clampNumber(limitB, 0, 200, 0));
        const selected = normalizeChannel(channel);
        const bMode = bStrengthMode === "percent" ? "percent" : "same";
        const bPercent = clampNumber(bStrengthPercent, 10, 100, 100);
        const requestedB = bMode === "percent"
            ? Math.round(safeStrength * bPercent / 100)
            : safeStrength;
        return {
            a: selected === "b" ? 0 : Math.min(safeStrength, safeA),
            b: selected === "a" ? 0 : Math.min(requestedB, safeB)
        };
    }

    function encodeV2Strength(strengthA, strengthB) {
        // V2 把两个 0～200 的界面强度各乘 7，打包进两个 11 位字段。
        const actualA = Math.round(clampNumber(strengthA, 0, 200, 0) * 7);
        const actualB = Math.round(clampNumber(strengthB, 0, 200, 0) * 7);
        const packed = (actualA << 11) | actualB;
        return new Uint8Array([
            packed & 0xff,
            (packed >>> 8) & 0xff,
            (packed >>> 16) & 0xff
        ]);
    }

    function decodeV3Frequency(encodedFrequency) {
        const value = Math.round(clampNumber(encodedFrequency, 10, 240, 10));
        if (value <= 100) {
            return value;
        }
        if (value <= 200) {
            return 100 + ((value - 100) * 5);
        }
        return 600 + ((value - 200) * 10);
    }

    function encodeV2WavePoint(point) {
        const safePoint = Array.isArray(point) ? point : [10, 0];
        const period = decodeV3Frequency(safePoint[0]);
        const pulseX = Math.max(1, Math.min(31, Math.floor(Math.sqrt(period / 1000) * 15)));
        const pauseY = Math.max(0, Math.min(1023, period - pulseX));
        const relative = clampNumber(safePoint[1], 0, 100, 0);
        const waveZ = Math.max(0, Math.min(20, Math.floor(relative / 5)));
        const packed = pulseX | (pauseY << 5) | (waveZ << 15);
        return new Uint8Array([
            packed & 0xff,
            (packed >>> 8) & 0xff,
            (packed >>> 16) & 0xff
        ]);
    }

    function expandV3WavePoint(point, enabled) {
        if (!enabled) {
            // 相对强度 101 是协议规定的无效值，用于明确关闭未选中的通道。
            return [10, 10, 10, 10, 101, 101, 101, 101];
        }
        const safePoint = Array.isArray(point) ? point : [10, 0];
        const frequency = Math.round(clampNumber(safePoint[0], 10, 240, 10));
        const relative = Math.round(clampNumber(safePoint[1], 0, 100, 0));
        return [
            frequency, frequency, frequency, frequency,
            relative, relative, relative, relative
        ];
    }

    function encodeV3Frame(options) {
        const settings = options || {};
        const sequence = Math.round(clampNumber(settings.sequence, 0, 15, 0));
        const mode = Math.round(clampNumber(settings.mode, 0, 15, 15));
        const strengthA = Math.round(clampNumber(settings.strengthA, 0, 200, 0));
        const strengthB = Math.round(clampNumber(settings.strengthB, 0, 200, 0));
        const waveA = expandV3WavePoint(settings.point, strengthA > 0);
        const waveB = expandV3WavePoint(settings.point, strengthB > 0);
        return new Uint8Array([
            0xb0,
            (sequence << 4) | mode,
            strengthA,
            strengthB,
            ...waveA,
            ...waveB
        ]);
    }

    function parseV3Notification(data) {
        let bytes;
        if (data instanceof Uint8Array) {
            bytes = data;
        } else if (data && data.buffer instanceof ArrayBuffer) {
            // 蓝牙事件通常给 DataView；必须尊重 byteOffset，不能误读同一缓冲区前面的旧字节。
            bytes = new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
        } else {
            bytes = new Uint8Array(data || []);
        }
        if (bytes.length < 4 || bytes[0] !== 0xb1) {
            return null;
        }
        return {
            sequence: bytes[1],
            strengthA: bytes[2],
            strengthB: bytes[3]
        };
    }

    return Object.freeze({
        UUIDS,
        channelStrengths,
        decodeV3Frequency,
        encodeV2Strength,
        encodeV2WavePoint,
        encodeV3Frame,
        normalizeChannel,
        parseV3Notification
    });
}));
