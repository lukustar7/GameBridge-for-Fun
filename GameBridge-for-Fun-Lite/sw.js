"use strict";

const CACHE_NAME = "gamebridge-lite-1.2.0-v2";
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
    self.skipWaiting();
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
    event.respondWith(
        fetch(event.request)
            .then((response) => {
                if (response && response.status === 200 && response.type === "basic") {
                    const responseToCache = response.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, responseToCache);
                    });
                }
                return response;
            })
            .catch(() => caches.match(event.request).then((cached) => cached || (event.request.mode === "navigate" ? caches.match("./index.html") : null)))
    );
});

self.addEventListener("message", (event) => {
    if (event.data && event.data.action === "activate-update") {
        self.skipWaiting();
    }
});
