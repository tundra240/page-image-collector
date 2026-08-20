#!/bin/bash
# Build a single-file Windows executable from this checkout.
#
# The result is ONE .exe containing the Node runtime, the app, node_modules and the
# public/ front-end. Nothing needs installing on the target machine: scanning uses
# the machine's own Chrome or Edge, and Edge ships with Windows.
#
# Runs on WSL/Linux and on Windows under Git Bash. It used to require python3 for the
# patch and the zip, which was fine from a WSL checkout and useless on Windows - where
# `python3` is usually a Microsoft Store stub that sits on PATH and refuses to run, so
# `command -v python3` succeeds and the build then dies on the first step. Everything
# now goes through node, which this project needs anyway.
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
node -e '
const fs = require("fs");
const file = "node_modules/playwright-core/lib/coreBundle.js";
const source = fs.readFileSync(file, "utf8");
const old = "    inspector = __toESM(require(\"inspector\"));";
const replacement =
  "    // pkg-patch: prebuilt single-file runtimes ship without the inspector module.\n" +
  "    try { inspector = __toESM(require(\"inspector\")); } catch { inspector = { url: () => undefined }; }";
if (source.includes("pkg-patch")) { console.log("     already patched"); process.exit(0); }
const hits = source.split(old).length - 1;
if (hits !== 1) {
  console.error("     ERROR: patch site not found (" + hits + " matches) - playwright-core may have changed");
  process.exit(1);
}
fs.writeFileSync(file, source.replace(old, replacement));
console.log("     patched");
'

echo "2/4  Building Windows executable (downloads a base runtime on first run)"
rm -rf "$STAGE" "$EXE" "$ZIP" dist/PageImageCollector
npm run build:win

echo "3/4  Verifying the build"
# Done in node rather than with `file` and `grep -a`, which are not dependably present
# on Windows. Checks the PE header properly rather than by string match, then looks for
# one string per feature that lives in an ASSET rather than in server.js: assets are
# copied in by pkg configuration, so a file added to public/ and never listed would
# vanish silently and only fail once the app was running on a machine without the
# source beside it. Each needle names something that would otherwise break invisibly.
node -e '
const fs = require("fs");
const exe = "dist/PageImageCollector.exe";
const buffer = fs.readFileSync(exe);

if (buffer.readUInt16LE(0) !== 0x5a4d) { console.error("     ERROR: no MZ header - not a Windows binary"); process.exit(1); }
const peOffset = buffer.readUInt32LE(0x3c);
if (buffer.readUInt32LE(peOffset) !== 0x00004550) { console.error("     ERROR: no PE signature"); process.exit(1); }
const machine = buffer.readUInt16LE(peOffset + 4);
if (machine !== 0x8664) { console.error("     ERROR: machine is 0x" + machine.toString(16) + ", expected x86-64"); process.exit(1); }

const needles = [
  // the app and its runtime dependency
  ["server.js reached the bundle", "reportedWait"],
  ["playwright browser registry", "browsers.json"],
  // public/index.html
  ["the page itself", "Page Image Collector"],
  ["address preview", "url-preview"],
  ["home screen", "home-panel"],
  ["reveal action", "Show me on the page"],
  ["acknowledgement", "With thanks to Keenu"],
  // public/app.js
  ["type filters", "buildFilters"],
  ["stale-server diagnosis", "responseCode"],
  // public/progress.js
  ["progress easing", "CREEP_ROOM"],
  ["progress module export", "APP_PROGRESS"],
  // public/errors.js
  ["error catalogue", "INVALID_URL"],
  ["version-gap error", "SERVER_OUTDATED"],
  // public/contours.js and the stylesheet
  ["contour background", "contour-canvas"],
  ["deselected-card greying", "--grey"],
  // public/guide.html - its CONTENT, not just its name
  ["the user guide", "Decide how many to take"],
  // lib/
  ["image location", "describeLocation"],
  ["candidate dedup", "uniqueCandidates"],
  ["reveal-on-page logic", "revealInPage"]
];

let missing = 0;
for (const [what, needle] of needles) {
  if (!buffer.includes(Buffer.from(needle, "utf8"))) {
    console.error("     ERROR: missing (" + what + "): " + needle);
    missing++;
  }
}
if (missing) process.exit(1);

const mb = (buffer.length / 1048576).toFixed(1);
console.log("     PE32+ x86-64, " + mb + " MB; " + needles.length + " asset checks passed");
'

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

Click "Guide" at the bottom of the page for how to use it.

Closing the console window stops the app.

Requirements: Windows 10 or 11 with Chrome or Edge. Edge is preinstalled, so
there is normally nothing to install. Node.js is NOT required - it is inside
the .exe.

Windows may warn that the file is unrecognised because it is not code-signed.
That is expected for a self-built executable: choose More info, then Run anyway.
TXT
# CRLF, so Notepad on a fresh Windows machine does not show it as one long line.
node -e '
const fs = require("fs");
const p = "dist/windows/README.txt";
fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/\r?\n/g, "\r\n"));
'

# Zipping is convenience, not the deliverable, so it tries what is available and says
# so rather than failing the build over it. No single tool is present everywhere:
# `zip` is absent from Git Bash, Compress-Archive is Windows-only, and bsdtar's -a is
# not in every tar.
zipped=""
if command -v zip >/dev/null 2>&1; then
  ( cd dist && zip -qr "$(basename "$ZIP")" windows ) && zipped="zip"
elif command -v powershell >/dev/null 2>&1; then
  powershell -NoProfile -Command \
    "Compress-Archive -Path 'dist/windows/*' -DestinationPath '$ZIP' -Force" && zipped="Compress-Archive"
elif tar --help 2>&1 | grep -q -- "-a,"; then
  ( cd dist && tar -a -c -f "$(basename "$ZIP")" windows ) && zipped="bsdtar"
fi

echo
echo "Done."
node -e '
const fs = require("fs");
const mb = p => (fs.statSync(p).size / 1048576).toFixed(1) + " MB";
console.log("  Executable: dist/PageImageCollector.exe  (" + mb("dist/PageImageCollector.exe") + ")");
try { console.log("  Zip:        dist/PageImageCollector-windows.zip  (" + mb("dist/PageImageCollector-windows.zip") + ")"); }
catch { console.log("  Zip:        not created - no zip tool found. Send the .exe, or the dist/windows folder."); }
'
echo
echo "Double-click the .exe to run it. Nothing needs installing alongside it."
