#!/bin/bash
# Build a single-file Windows executable from this WSL checkout.
#
# The result is ONE .exe containing the Node runtime, the app, node_modules and the
# public/ front-end. Nothing needs installing on the target machine: scanning uses
# the machine's own Chrome or Edge, and Edge ships with Windows.
set -euo pipefail
cd "$(dirname "$0")"

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true

STAGE="dist/windows"
EXE="dist/PageImageCollector.exe"
ZIP="dist/PageImageCollector-windows.zip"

echo "1/4  Patching playwright-core for single-file packaging"
# pkg's prebuilt Node runtimes are compiled without the inspector module, and
# playwright-core requires it at load time. Its only use is `!!inspector.url()` to
# detect an attached JS debugger, so an undefined url is the correct answer when the
# module is missing. npm install overwrites this, hence re-applying on every build.
python3 - <<'PY'
import io
p = 'node_modules/playwright-core/lib/coreBundle.js'
s = io.open(p, encoding='utf-8').read()
old = '    inspector = __toESM(require("inspector"));'
new = ('    // pkg-patch: prebuilt single-file runtimes ship without the inspector module.\n'
       '    try { inspector = __toESM(require("inspector")); } catch { inspector = { url: () => undefined }; }')
if 'pkg-patch' in s:
    print('     already patched')
elif s.count(old) == 1:
    io.open(p, 'w', encoding='utf-8').write(s.replace(old, new))
    print('     patched')
else:
    raise SystemExit('     ERROR: patch site not found - playwright-core may have changed')
PY

echo "2/4  Building Windows executable (downloads a base runtime on first run)"
rm -rf "$STAGE" "$EXE" "$ZIP" dist/PageImageCollector
npm run build:win

echo "3/4  Verifying the build"
file "$EXE" | grep -q "PE32+ executable" || { echo "     ERROR: not a Windows binary"; exit 1; }
# One string per feature that lives in an asset rather than in server.js. Assets are
# copied in by pkg configuration, so a file added to public/ and never listed would
# vanish silently and only fail once the app was running on Windows. Each of these
# names a thing that would otherwise break invisibly.
for needle in \
  buildFilters \
  "Page Image Collector" \
  browsers.json \
  CREEP_ROOM \
  APP_PROGRESS \
  INVALID_URL \
  url-preview \
  slime-drift \
  describeLocation \
  uniqueCandidates \
  reportedWait
do
  grep -q -a -F "$needle" "$EXE" || { echo "     ERROR: '$needle' missing from the bundle"; exit 1; }
done
echo "     PE32+ x86-64; app, front-end, error catalogue, progress easing and styles embedded"

echo "4/4  Creating zip"
mkdir -p "$STAGE"
cp "$EXE" "$STAGE/"
cat > "$STAGE/README.txt" <<'TXT'
Page Image Collector - Windows
==============================

Double-click PageImageCollector.exe.

A console window opens and a browser window follows, pointed at
http://127.0.0.1:3719 - that is the app. Paste a page address and press
"Find images". A second, automated browser window scrolls the page to trigger
lazy loading; let it work. When it finishes you can filter the results by file
type and save the ones you want.

Closing the console window stops the app.

Requirements: Windows 10 or 11 with Chrome or Edge. Edge is preinstalled, so
there is normally nothing to install. Node.js is NOT required - it is inside
the .exe.

Windows may warn that the file is unrecognised because it is not code-signed.
That is expected for a self-built executable.
TXT
sed -i 's/$/\r/' "$STAGE/README.txt"
( cd dist && python3 -m zipfile -c "$(basename "$ZIP")" windows )

echo
echo "Done."
echo "  Executable: $EXE  ($(du -h "$EXE" | cut -f1))"
echo "  Zip:        $ZIP  ($(du -h "$ZIP" | cut -f1))"
echo
echo "Copy the .exe (or the zip) to Windows and double-click it."
