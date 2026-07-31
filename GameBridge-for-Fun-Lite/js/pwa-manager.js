(function (root) {
    "use strict";

    class PwaManager {
        constructor() {
            this.registration = null;
            this.updateCallback = function () {};
            this.reloadRequested = false;
        }

        onUpdateFound(callback) {
            this.updateCallback = typeof callback === "function" ? callback : function () {};
        }

        async init() {
            if (!("serviceWorker" in navigator) || !window.isSecureContext) {
                return { supported: false, controlled: false };
            }
            try {
                this.registration = await navigator.serviceWorker.register("./sw.js", { scope: "./" });
                navigator.serviceWorker.addEventListener("controllerchange", () => {
                    if (this.reloadRequested) {
                        window.location.reload();
                    }
                });
                this.registration.addEventListener("updatefound", () => {
                    const worker = this.registration.installing;
                    if (!worker) {
                        return;
                    }
                    worker.addEventListener("statechange", () => {
                        if (worker.state === "installed" && navigator.serviceWorker.controller) {
                            this.updateCallback();
                        }
                    });
                });
                if (this.registration.waiting && navigator.serviceWorker.controller) {
                    this.updateCallback();
                }
                return {
                    supported: true,
                    controlled: Boolean(navigator.serviceWorker.controller)
                };
            } catch (error) {
                return { supported: true, controlled: false, error };
            }
        }

        async checkForUpdate() {
            if (!this.registration) {
                return false;
            }
            await this.registration.update();
            return Boolean(this.registration.waiting);
        }

        applyUpdate(isSafeToReload) {
            if (!isSafeToReload || !this.registration || !this.registration.waiting) {
                return false;
            }
            this.reloadRequested = true;
            this.registration.waiting.postMessage({ action: "activate-update" });
            return true;
        }

        static isInstalled() {
            return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
        }
    }

    root.LitePwaManager = Object.freeze({ PwaManager });
}(typeof globalThis !== "undefined" ? globalThis : this));
