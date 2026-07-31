(function exposeLiteGameRuntime(root, factory) {
    "use strict";

    const api = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.LiteGameRuntime = api;
    }
}(typeof globalThis !== "undefined" ? globalThis : this, function createLiteGameRuntime() {
    "use strict";

    function clamp(value, minimum, maximum) {
        const number = Number(value);
        return Math.min(maximum, Math.max(minimum, Number.isFinite(number) ? number : minimum));
    }

    function getShakeZoneState(ball, cfg, width, height) {
        const safeWidth = Math.max(1, Number(width) || 1);
        const safeHeight = Math.max(1, Number(height) || 1);
        const minSide = Math.min(safeWidth, safeHeight);
        const centerX = safeWidth / 2;
        const centerY = safeHeight / 2;
        const x = Number.isFinite(Number(ball && ball.x)) ? Number(ball.x) : centerX;
        const y = Number.isFinite(Number(ball && ball.y)) ? Number(ball.y) : centerY;
        const distance = Math.hypot(x - centerX, y - centerY);
        const outer = minSide * clamp(cfg && cfg.safeRadius, 0, 100) / 100;
        const inner = cfg && cfg.mode === "gap"
            ? minSide * clamp(cfg.gapInner, 0, 100) / 100
            : 0;
        const err = cfg && cfg.mode === "gap"
            ? (distance < inner ? inner - distance : Math.max(0, distance - outer))
            : Math.max(0, distance - outer);
        return {
            centerX,
            centerY,
            inner,
            outer,
            err,
            dangerRatio: clamp(err / (minSide * 0.22), 0, 1)
        };
    }

    function getAngleState(offset, cfg) {
        const safeOffset = clamp(offset, -90, 90);
        const target = clamp(cfg && cfg.targetOffset, -45, 45);
        const tolerance = clamp(cfg && cfg.tolerance, 0, 90);
        const rampDegrees = Math.max(1, Number(cfg && cfg.rampDegrees) || 1);
        const rawErr = Math.abs(safeOffset - target) - tolerance;
        const err = Math.max(0, rawErr);
        return {
            offset: safeOffset,
            err,
            dangerRatio: clamp(err / rampDegrees, 0, 1)
        };
    }

    function interpolateStrength(minimum, maximum, ratio) {
        const safeMinimum = clamp(minimum, 0, 200);
        const safeMaximum = clamp(maximum, safeMinimum, 200);
        return Math.round(safeMinimum + (safeMaximum - safeMinimum) * clamp(ratio, 0, 1));
    }

    function rollDie(random) {
        const source = typeof random === "function" ? random : Math.random;
        return 1 + Math.floor(clamp(source(), 0, 0.999999) * 6);
    }

    function rollOpponentDie(difficulty, random) {
        const source = typeof random === "function" ? random : Math.random;
        let value = rollDie(source);
        if (difficulty === "easy" && source() < 0.28) {
            value = Math.max(1, value - 1);
        } else if (difficulty === "hard" && source() < 0.28) {
            value = Math.min(6, value + 1);
        }
        return value;
    }

    function motionForce(event) {
        const acceleration = event && (event.acceleration || event.accelerationIncludingGravity) || {};
        const x = Number(acceleration.x);
        const y = Number(acceleration.y);
        const z = Number(acceleration.z);
        if (![x, y, z].every(Number.isFinite)) {
            return null;
        }
        return Math.hypot(x, y, z);
    }

    return Object.freeze({
        getAngleState,
        getShakeZoneState,
        interpolateStrength,
        motionForce,
        rollDie,
        rollOpponentDie
    });
}));
