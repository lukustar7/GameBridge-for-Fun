(function (root, factory) {
    "use strict";

    const api = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    }
    root.LiteWaveforms = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const DEFAULT_KEY = "game_default";
    const RANDOM_KEY = "random";

    function pairs(frequency, strengths) {
        return strengths.map((strength) => [frequency, strength]);
    }

    function alternating(repeats) {
        const result = [];
        for (let index = 0; index < repeats; index += 1) {
            result.push([10, 0], [10, 100]);
        }
        result.push([10, 0]);
        return result;
    }

    const profiles = Object.freeze({
        game_default: Object.freeze({ label: "游戏默认", points: [[10, 55], [10, 100], [14, 72], [20, 92], [10, 60]] }),
        extrusion: Object.freeze({ label: "挤压", points: [[10, 0], [10, 100]] }),
        bubble: Object.freeze({ label: "气泡", points: [[45, 0], [45, 100]] }),
        rhythm: Object.freeze({ label: "律动", points: [[10, 0], [10, 50], [10, 100], [10, 0], [10, 50], [10, 100], [25, 100], [29, 100], [34, 100], [38, 100], [43, 100], [10, 0], [10, 0]] }),
        air_waves: Object.freeze({ label: "电波", points: [[10, 100], [23, 100], [36, 100], [50, 100], [10, 0], [10, 100], [10, 0], [10, 100], [10, 0], [10, 100], [10, 0], [10, 100], [10, 0]] }),
        dance: Object.freeze({ label: "舞步", points: [[10, 0], [10, 0], [10, 100], [10, 0], [10, 0], [10, 100], [10, 0], [10, 0], [10, 100], [10, 100], [10, 100], [10, 0], [10, 0], [10, 100], [10, 100], [10, 100]] }),
        climb: Object.freeze({ label: "攀登", points: [[48, 50], [40, 60], [32, 70], [25, 80], [17, 90], [10, 100]] }),
        shade: Object.freeze({ label: "树荫", points: [[100, 100], [100, 100]] }),
        pulse: Object.freeze({ label: "脉冲", points: [10, 13, 16, 19, 22, 28, 37, 46, 55, 64, 78, 108, 121, 134, 147, 160].map((frequency) => [frequency, 100]) }),
        breathing: Object.freeze({ label: "呼吸", points: pairs(10, [0, 20, 40, 60, 80, 100, 100, 100, 0, 0, 0, 0]) }),
        tide: Object.freeze({ label: "潮汐", points: [[10, 0], [11, 16], [13, 33], [14, 50], [16, 66], [18, 83], [19, 100], [21, 92], [22, 84], [24, 76], [26, 68], [26, 0], [27, 16], [29, 33], [30, 50], [32, 66], [34, 83], [35, 100], [37, 92], [38, 84], [40, 76], [42, 68], [10, 0]] }),
        pulsating: Object.freeze({ label: "连击", points: pairs(10, [100, 0, 100, 66, 33, 0, 0, 0, 100, 0, 100, 66, 33, 0, 0, 0, 100, 0, 100, 66, 33, 0, 0, 0]) }),
        quick_rub: Object.freeze({ label: "快速按捏", points: alternating(23) }),
        gradual_rub: Object.freeze({ label: "按捏渐强", points: pairs(10, [0, 28, 0, 52, 0, 73, 0, 87, 0, 100, 0, 0, 28, 0, 52, 0, 73, 0, 87, 0, 100, 0, 0]) }),
        heartbeat: Object.freeze({ label: "心跳节奏", points: pairs(112, [100, 100, 100, 100, 100, 100]).concat(pairs(10, [0, 0, 0, 0, 0, 75, 83, 91, 100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 75, 83, 91, 100, 0, 0, 0, 0, 0, 0])) }),
        compress: Object.freeze({ label: "压缩", points: [74, 69, 64, 59, 54, 50, 45, 40, 35, 30, 26, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10].map((frequency) => [frequency, 100]) }),
        rhythmic: Object.freeze({ label: "节奏步伐", points: pairs(10, [0, 20, 40, 60, 80, 100, 0, 25, 50, 75, 100, 0, 33, 66, 100, 0, 50, 100, 0, 100, 0, 100, 0, 100, 0, 100, 0]) })
    });

    const shortRandom = Object.freeze(["extrusion", "bubble", "climb", "pulsating", "quick_rub", "rhythmic"]);
    const mediumRandom = Object.freeze(shortRandom.concat(["rhythm", "air_waves", "dance", "breathing", "gradual_rub"]));
    const longRandom = Object.freeze(mediumRandom.concat(["tide", "heartbeat", "compress", "pulse"]));

    function clampDuration(durationMs) {
        const value = Number(durationMs);
        return Math.max(100, Math.min(60000, Number.isFinite(value) ? Math.round(value) : 100));
    }

    function normalizeKey(value) {
        const key = typeof value === "string" ? value.trim().toLowerCase() : "";
        return key === RANDOM_KEY || Object.prototype.hasOwnProperty.call(profiles, key) ? key : DEFAULT_KEY;
    }

    function resolveKey(value, durationMs, randomValue) {
        const key = normalizeKey(value);
        if (key !== RANDOM_KEY) {
            return key;
        }
        const duration = clampDuration(durationMs);
        const choices = duration <= 1000 ? shortRandom : (duration <= 3000 ? mediumRandom : longRandom);
        const sample = Number.isFinite(randomValue) ? randomValue : Math.random();
        return choices[Math.min(choices.length - 1, Math.max(0, Math.floor(sample * choices.length)))];
    }

    function rotateToFirstEffective(points) {
        const index = points.findIndex((point) => point[1] > 0);
        return index <= 0 ? points.slice() : points.slice(index).concat(points.slice(0, index));
    }

    function fitPoints(value, durationMs, randomValue) {
        const duration = clampDuration(durationMs);
        const key = resolveKey(value, duration, randomValue);
        const frameCount = Math.max(1, Math.ceil(duration / 100));
        let source = profiles[key].points.map((point) => point.slice());
        if (frameCount <= 10) {
            source = rotateToFirstEffective(source);
        }
        if (frameCount < source.length) {
            return Array.from({ length: frameCount }, (_unused, frameIndex) => {
                const start = Math.floor(frameIndex * source.length / frameCount);
                const end = Math.max(start + 1, Math.floor((frameIndex + 1) * source.length / frameCount));
                return source.slice(start, end).reduce((highest, point) => point[1] > highest[1] ? point : highest).slice();
            });
        }
        return Array.from({ length: frameCount }, (_unused, index) => source[index % source.length].slice());
    }

    function listOptions() {
        return [{ key: RANDOM_KEY, label: "随机" }].concat(
            Object.entries(profiles).map(([key, profile]) => ({ key, label: profile.label }))
        );
    }

    return Object.freeze({
        DEFAULT_KEY,
        RANDOM_KEY,
        fitPoints,
        listOptions,
        normalizeKey,
        profiles,
        resolveKey
    });
}));
