"use strict";

const CACHE_NAME = "gamebridge-lite-0.1.0-beta.2";
const APP_SHELL = Object.freeze([
    "./",
    "./index.html",
    "./manifest.json",
    "./css/style.css",
    "./icons/icon-192.svg",
    "./js/coyote-protocol.js",
    "./js/waveforms.js",
    "./js/game-logic.js",
    "./js/game-config.js",
    "./js/game-runtime.js",
    "./js/ble-driver.js",
    "./js/output-controller.js",
    "./js/pwa-manager.js",
    "./js/main.js"
]);

self.addEventListener("install", (event) => {
    // 新版本只下载到 waiting；绝不在正在输出的页面背后强制接管。
    event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys()
            .then((names) => Promise.all(
                names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener("fetch", (event) => {
    if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) {
        return;
    }
    if (event.request.mode === "navigate") {
        event.respondWith(
            fetch(event.request).catch(() => caches.match("./index.html"))
        );
        return;
    }
    event.respondWith(
        caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
});

self.addEventListener("message", (event) => {
    if (event.data && event.data.action === "activate-update") {
        self.skipWaiting();
    }
});
