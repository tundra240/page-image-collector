#!/bin/bash
# Launcher for WSL / Linux. See WSL-COMPATIBILITY.md for why this differs from the
# Windows and macOS launchers.
set -u
cd "$(dirname "$0")"

# nvm installs node into the user's home rather than /usr/bin, and it is only on PATH
# once its script has been sourced. A double-clicked or non-interactive shell has not.
if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
  . "$HOME/.nvm/nvm.sh"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install the current LTS release, then run this again."
  exit 1
fi

if [ ! -d node_modules/express ]; then
  echo "Setting up Page Image Collector for the first time..."
  npm install --no-audit --no-fund || { echo "Setup could not finish. Check your internet connection."; exit 1; }
fi

# The scan needs a Linux browser: Playwright drives a browser over Linux process pipes,
# which WSL interop cannot pass to a Windows Chrome under /mnt/c.
if ! node -e 'require("fs").accessSync(require("playwright-core").chromium.executablePath())' 2>/dev/null; then
  echo "Downloading Playwright Chromium (about 115 MB, no administrator rights needed)..."
  node node_modules/playwright-core/cli.js install chromium || { echo "Chromium download failed."; exit 1; }
fi

if [ ! -d .wsl-browser-libs/usr/lib/x86_64-linux-gnu ]; then
  echo "Note: .wsl-browser-libs is missing. If the browser fails to start, recreate it as"
  echo "described in WSL-COMPATIBILITY.md."
fi

if [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
  echo "Note: no display detected. The scan opens a visible browser window and needs WSLg."
fi

node server.js
