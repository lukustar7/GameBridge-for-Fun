# Repository Guidelines

## Project Structure & Module Organization

Python backend code lives in `server/`: `server.py` is the entry point for static delivery, HTTP/HTTPS and WebSocket endpoints, certificates, and device-App bridging, alongside `dglab_v4.py`, `coyote_waveforms.py`, and `macos_preflight.py`. Browser code lives in `static/`: `index.html` and `console.js` implement the desktop console; `game.html`, `game.js`, and `game-logic.js` implement the mobile games and testable rules. `android/` contains the Kotlin APK shell, native sensor bridge, restricted WebView, and Android unit tests. Shared styles are in `style.css`. Treat `qrcode.min.js` as vendored code. `coyote/` contains protocol references, not runtime code. User instructions belong in `README.md` and `USER_GUIDE.md`.

## Build, Test, and Development Commands

- `python3 -m pip install -r requirements.txt` installs the pinned bridge dependency.
- `uv sync` creates the same pinned environment in `.venv` from `pyproject.toml` and `uv.lock` (developer alternative; `start.command` keeps the pip flow).
- `python3 server/server.py` starts the service directly for development.
- `./start.command` performs the macOS dependency check and starts the service.
- `python3 -m py_compile server/server.py` checks Python syntax without starting hardware connections.
- `node --check static/console.js` and `node --check static/game.js` check JavaScript syntax when Node.js is available.
- `python3 -m unittest discover -s tests -v` runs the HTTP, WebSocket, limit, and output-scheduler regression suite.
- `./android/build-debug.command` runs Android URL-boundary tests, lint, and the debug build, then refreshes and verifies the signed package and checksum in `APK/`.
- `./verify.command` runs Python, browser-rule, packaged-Android, service-smoke, and diff checks as the complete local acceptance gate.

There is no separate compilation step. The service normally opens the console; otherwise visit `http://localhost:18080`.

## Coding Style & Naming Conventions

Use four spaces in Python and JavaScript. Use Python `snake_case`, `UPPER_SNAKE_CASE` constants, browser-side `camelCase`, and kebab-case HTML IDs and CSS classes. Keep comments concise and in Chinese, matching the source. Prefer direct functions and native browser APIs. Do not reformat vendored or reference files during unrelated changes.

## Testing Guidelines

There is no coverage threshold. Every change must pass the automated suite and Python/JavaScript syntax checks, followed by a service smoke test. For UI changes, check mobile and desktop widths, reconnection, empty states, and rapid input. For output changes, verify disconnected-App behavior, A/B selection, duration and strength limits, cooldowns, and emergency stop before using hardware.

## Commit & Pull Request Guidelines

History follows Conventional Commits: `feat:`, `fix:`, `docs:`, and `refactor:`. Use a focused summary, such as `fix: stop output when game socket closes`. Update `CHANGELOG.md` under `Unreleased` for completed features, fixes, or security work. Pull requests must describe behavior, list validation, link issues, and include UI screenshots. State certificate, network, token, or hardware-safety impact explicitly.

## Security & Configuration Tips

Never commit `certs/`, keys, tokens, or generated QR data. Server-side strength, duration, rate, and token checks remain authoritative. Document new `GAME_BRIDGE_FOR_FUN_*` variables in `README.md`.
