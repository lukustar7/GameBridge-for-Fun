# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local-LAN bridge service (macOS host) that forwards results from phone web mini-games to the DG-LAB 4 App, which drives Coyote 2.0/3.0 hardware over Bluetooth. All docs, comments, and commit context are in Chinese; keep new comments concise and in Chinese to match. `AGENTS.md` is the canonical contributor guide — read it alongside this file.

## Commands

```bash
python3 -m pip install -r requirements.txt   # only dep: websockets==12.0 (pinned)
uv sync                                      # same pinned env via uv (.venv from pyproject.toml + uv.lock)
python3 server/server.py                     # run service directly for development
./start.command                              # macOS launcher with full preflight (venv, certs, deps)

python3 -m unittest discover -s tests -v     # full Python regression suite
python3 -m unittest tests.test_server.SomeClass.test_name -v   # single test
node --test tests/test_game_logic.js         # browser game-rule tests (Node)
node --check static/console.js static/game.js static/game-logic.js  # JS syntax check
python3 -m py_compile server/server.py server/dglab_v4.py server/coyote_waveforms.py server/macos_preflight.py

./android/build-debug.command                # Android unit tests + lint + debug build, refreshes APK/
./verify.command                             # complete local acceptance gate (run before delivering)
```

`verify.command` runs, in order: Python syntax + unittest suite → Node checks + game-logic tests → Android build/verify → full-service HTTP smoke test (uses `GAME_BRIDGE_FOR_FUN_NO_BROWSER=1`) with SIGTERM safe-shutdown verification → `git diff --check`. Any failure aborts.

The Android build needs Android Studio's bundled JBR and SDK; there is no other Node/Java/npm tooling — the project is plain stdlib Python plus vanilla browser JS.

## Architecture

Data flow: **desktop console (browser)** and **phone game page (browser or Android WebView APK)** connect via WebSocket to `server/server.py`, which bridges to the **DG-LAB 4 App** (phone scans a V4 QR code), which controls the hardware via Bluetooth.

Fixed ports: HTTP 18080, web WS 18081, App bridge WS 15678, HTTPS 18443, secure web WS 18444. HTTPS exists because phone motion sensors require a secure context; the server auto-generates per-LAN-IP certificates with OpenSSL (root CA 90 days, server cert 7 days, private keys in `~/Library/Application Support/GameBridge for Fun/certs/private/`).

- `server/server.py` — monolithic entry point: static file serving, HTTP/HTTPS, both WS endpoints, certificate generation, and all output scheduling/safety enforcement. Sections are marked with `# --- N. ... ---` comments.
- `server/dglab_v4.py` — `DGLabV4Bridge`: V4 handshake, device discovery/selection, state sanitize/merge, request/response RPC with the App, and 2.0-vs-3.0 adaptation (V2 three-byte vs V3 eight-byte waveform frames, chosen by reported device type).
- `server/coyote_waveforms.py` — 16 classic waveforms plus adaptive/random strategies, short-duration compression, V2/V3 frame encoding.
- `server/macos_preflight.py` — dependency/file/network/cert/APK integrity checks used by `start.command`.
- `static/` — `index.html` + `console.js` (desktop console), `game.html` + `game.js` (four mini-games, sensors, settings persistence, punishment reporting), `game-logic.js` (pure rules, no DOM/network — shared by browser and `tests/test_game_logic.js`). `qrcode.min.js` is vendored; do not touch it in unrelated changes.
- `android/` — Kotlin APK shell (`app.gamebridgeforfun.mobile`, Android 15+): native sensor bridge into the same web game pages over plain LAN HTTP/WS (no cert install needed), restricted WebView, URL/token validation. The signed debug APK and its SHA-256 in `APK/` are tracked deliverables that `build-debug.command` refreshes.
- `coyote/` — protocol source index only, not runtime code. Upstream documents are linked instead of copied so their current terms and corrections remain authoritative.
- `tests/test_ui_structure.py` and `tests/test_repository_hygiene.py` assert on HTML structure and repo layout respectively — structural changes to `static/*.html` or top-level files can fail them.

## Upstream protocol documentation

DG-LAB's official open-source org is https://github.com/dungeonlab-open. Verified mapping to this codebase (no upstream repo is a code dependency — local code reimplements the protocols):

- [dglab-bluetooth-protocol](https://github.com/dungeonlab-open/dglab-bluetooth-protocol) — BLE V2/V3 waveform spec; `coyote_waveforms.py` implements the documented V2 3-byte X/Y/Z packing and V3 8-byte (4×freq + 4×intensity, 10–240 encoding) frames.
- [dglab-kit](https://github.com/dungeonlab-open/dglab-kit) — its README is the primary spec for the **V4 socket protocol** `dglab_v4.py` speaks: the `dungeon-lab.cn/s/?v=1&action=socket` QR deep link, `/v4?tid=` path, `hello`/`controller_attached`/`heartbeat`/`pong` frames, `reqId` RPC (`device.op`, `device.op.clear`, `ping`), action types AppendPulseData=0/SetTempIntensity=4/SetIntensity=7, and `COYOTE_020`/`COYOTE_030`.
- [dglab-kit-python](https://github.com/dungeonlab-open/dglab-kit-python) (`src/dglab_kit_python/socket/v4.py`) and [dglab-websocket-server](https://github.com/dungeonlab-open/dglab-websocket-server) (`v4-server.ts`) — official controller SDK and relay for the same V4 protocol; useful as reference implementations. `dglab_v4.py` plays the server+controller side so the DG-LAB 4 App connects directly to this machine (no cloud relay).
- [dglab-websocket-simple](https://github.com/dungeonlab-open/dglab-websocket-simple) (archived) — `socket/DG_WAVES_V2_V3_simple.js` holds classic-waveform V2/V3 hex test vectors that match `coyote_waveforms.py` output frame-for-frame; good for validating encoder changes.

Beware the generation trap: upstream also documents an older App-3-era "V3 socket" protocol (`bind`/`msg` frames, `strength-…`/`pulse-…` string commands, `wss://ws.dungeon-lab.cn/`). This codebase does **not** implement it — only the V4 protocol above.

## Safety model (the core invariant)

The server never trusts LAN clients. Frontend limits are advisory; `server/server.py` independently enforces strength clamps, duration bounds (100ms–60s), per-connection rate limiting, test-shock caps (default 15, max 30, ≤1s, 1.5s cooldown), and channel A/B limits reported by the App (unknown limit ≠ 200; treat as not-ready). Layered dead-man switches: every nonzero V4 strength carries an auto-expiry so the App zeroes output even if the PC process dies; an output watchdog stops output if the owning game page misses heartbeats (3.5s) or continuous-mode pulses go idle (0.75s); SIGTERM triggers a safe-shutdown path that clears output first. Any change to output paths must preserve all of these — verify disconnected-App behavior, A/B selection, limits, cooldowns, and emergency stop before touching hardware.

Access control: the console is loopback-only and the sole reader of the per-run game token; game endpoints require that token; static serving exposes only `static/` and the two root-cert downloads (never source, `.git`, or private keys).

## Conventions

- Four-space indent everywhere. Python `snake_case` / `UPPER_SNAKE_CASE`; browser JS `camelCase`; HTML IDs and CSS classes kebab-case.
- Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`); update `CHANGELOG.md` under `Unreleased` for completed features/fixes/security work.
- Never commit `certs/`, keys, tokens, or generated QR data. Document any new `GAME_BRIDGE_FOR_FUN_*` env var in `README.md`.
- New game rules go in `game-logic.js` (pure, testable) rather than `game.js` when they don't need DOM/sensors.
