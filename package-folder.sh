#!/bin/bash
# Build a self-contained Windows FOLDER from this WSL checkout.
#
# The alternative to package-windows.sh. Both produce something that needs nothing
# installed on the target machine; the difference is what you get afterwards:
#
#   the .exe     one sealed file. Changing a colour means rebuilding all 62MB.
#   this folder  ordinary files. Edit public/style.css, refresh the browser, done.
#
# Node itself is bundled in runtime/, and node_modules is installed here rather than
# on first run, so the folder works with no Node installed and no internet.
set -euo pipefail
cd "$(dirname "$0")"

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true

# Matches the runtime the .exe is built against, so both routes run the same Node.
NODE_VERSION="v22.23.2"
CACHE="$HOME/.cache/pic-build"
STAGE="dist/PageImageCollector"
ZIP="dist/PageImageCollector-folder.zip"

echo "1/5  Fetching the Windows Node runtime ($NODE_VERSION)"
mkdir -p "$CACHE"
NODE_ZIP="$CACHE/node-$NODE_VERSION-win-x64.zip"
if [ -f "$CACHE/node.exe" ]; then
  echo "     already cached"
else
  curl -fL --retry 3 -o "$NODE_ZIP" \
    "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-win-x64.zip"
  # Only node.exe is needed; the rest of the distribution is npm and docs.
  python3 - "$NODE_ZIP" "$CACHE" <<'PY'
import sys, zipfile, os
src, dest = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(src) as z:
    name = next(n for n in z.namelist() if n.endswith('/node.exe'))
    with z.open(name) as f, open(os.path.join(dest, 'node.exe'), 'wb') as out:
        out.write(f.read())
print('     extracted node.exe')
PY
  rm -f "$NODE_ZIP"
fi

echo "2/5  Staging the app"
rm -rf "$STAGE" "$ZIP"
mkdir -p "$STAGE/runtime"
cp "$CACHE/node.exe" "$STAGE/runtime/node.exe"
cp server.js package.json "$STAGE/"
cp -r public lib "$STAGE/"
cp README.md ERRORS.md GLOSSARY.md ARCHITECTURE.md "$STAGE/" 2>/dev/null || true

echo "3/5  Installing production dependencies into the folder"
# --omit=dev keeps the packaging toolchain out: @yao-pkg/pkg alone is far larger than
# the app. Installed now rather than on first run, so the folder needs no internet.
( cd "$STAGE" && npm install --omit=dev --no-audit --no-fund --silent )
# npm rewrites package.json scripts paths in some setups; the app never reads them.
rm -rf "$STAGE/node_modules/.package-lock.json"

echo "4/5  Writing the launcher"
cat > "$STAGE/Start Image Collector.bat" <<'BAT'
@echo off
setlocal
title Page Image Collector
cd /d "%~dp0"

if not exist "runtime\node.exe" (
  echo.
  echo This folder is incomplete - runtime\node.exe is missing.
  echo Unzip the whole folder rather than copying single files out of it.
  echo.
  pause
  exit /b 1
)

echo Starting Page Image Collector...
echo Close this window to stop the app.
echo.
"runtime\node.exe" server.js
if errorlevel 1 (
  echo.
  echo The app stopped unexpectedly. The message above says why.
  echo.
  pause
)
BAT
sed -i 's/$/\r/' "$STAGE/Start Image Collector.bat"

cat > "$STAGE/README.txt" <<'TXT'
Page Image Collector - Windows folder edition
=============================================

Double-click "Start Image Collector.bat".

A console window opens and a browser follows, pointed at http://127.0.0.1:3719 -
that is the app. Paste a page address and press "Find images". A second,
automated browser window scrolls the page to trigger lazy loading; let it work.
When it finishes you can filter the results by file type and save the ones you
want. Closing the console window stops the app.

Requirements: Windows 10 or 11 with Chrome or Edge. Edge is preinstalled, so
there is normally nothing to install. Node.js is NOT required - it is in
runtime\node.exe inside this folder.

Keep the folder together. Moving "Start Image Collector.bat" out on its own will
not work; it needs the files beside it.

Changing how it looks
---------------------
Unlike the single-file .exe, everything here is an ordinary file you can edit:

  public\style.css   colours and the animated background. The six masses are the
                     .b1 to .b6 rules; their alpha values control how strong the
                     green is.
  public\index.html  the page itself
  public\app.js      what happens in the browser
  server.js          the scanning logic

Edit, save, then refresh the browser. No rebuild. If a style change does not
appear, press Ctrl+Shift+R to bypass the browser cache.
TXT
sed -i 's/$/\r/' "$STAGE/README.txt"

echo "5/5  Verifying and zipping"
for required in \
  "runtime/node.exe" "server.js" "public/index.html" "public/style.css" \
  "public/app.js" "public/errors.js" "public/progress.js" \
  "lib/declared.js" "lib/scan-limits.js" "lib/image-location.js" \
  "node_modules/express/package.json" "node_modules/playwright-core/package.json" \
  "Start Image Collector.bat"
do
  [ -e "$STAGE/$required" ] || { echo "     ERROR: $required missing from the folder"; exit 1; }
done
# The packaging toolchain must not have come along for the ride.
[ -d "$STAGE/node_modules/@yao-pkg" ] && { echo "     ERROR: dev dependencies were included"; exit 1; }
grep -q "slime-drift" "$STAGE/public/style.css" || { echo "     ERROR: styles look stale"; exit 1; }
echo "     all files present, no dev dependencies"

( cd dist && python3 -m zipfile -c "$(basename "$ZIP")" PageImageCollector )

echo
echo "Done."
echo "  Folder: $STAGE  ($(du -sh "$STAGE" | cut -f1))"
echo "  Zip:    $ZIP  ($(du -h "$ZIP" | cut -f1))"
echo
echo "Copy the folder (or the zip) to Windows and run \"Start Image Collector.bat\"."
