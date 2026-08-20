#!/bin/bash
set -u
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install the current LTS release from: https://nodejs.org/"
  read -r -p "Press Return to close..." _
  exit 1
fi

if [ ! -d node_modules/express ]; then
  echo "Setting up Page Image Collector for the first time..."
  if ! npm install --no-audit --no-fund; then
    echo "Setup could not finish. Check your internet connection, then try again."
    read -r -p "Press Return to close..." _
    exit 1
  fi
fi

node server.js
