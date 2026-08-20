# Error reference

Every error Page Image Collector can report, what it means, and what to do about it.

**This file is generated.** The source of truth is [`public/errors.js`](public/errors.js);
regenerate with `npm run docs:errors`. `npm test` fails if a code here goes missing, so the
two cannot drift apart.

Each error carries a stable `code` as well as a message. Messages are written for people and
may be reworded; **codes are the contract** and are what the app matches on.

## Codes at a glance

| Code | Where | HTTP | Can the app help itself? |
| --- | --- | --- | --- |
| [`SCAN_IN_PROGRESS`](#scan-in-progress) | server | 409 | Yes — `retry` |
| [`INVALID_URL`](#invalid-url) | server | 400 | Yes — `repair-url` |
| [`UNSUPPORTED_SCHEME`](#unsupported-scheme) | server | 400 | No — advice only |
| [`NO_BROWSER`](#no-browser) | server | 500 | Yes — `install-browser` |
| [`PAGE_TIMEOUT`](#page-timeout) | server | 500 | Yes — `retry` |
| [`SCAN_FAILED`](#scan-failed) | server | 500 | No — advice only |
| [`IMAGE_EXPIRED`](#image-expired) | server | 404 | No — advice only |
| [`SERVER_UNREACHABLE`](#server-unreachable) | browser | — | Yes — `restart-server` |
| [`NOTHING_SELECTED`](#nothing-selected) | browser | — | No — advice only |
| [`NO_DIRECTORY_PICKER`](#no-directory-picker) | browser | — | No — advice only |
| [`SAVE_READ_FAILED`](#save-read-failed) | browser | — | No — advice only |
| [`SAVE_CANCELLED`](#save-cancelled) | browser | — | No — advice only |
| [`PORT_IN_USE`](#port-in-use) | startup | — | No — advice only |
| [`NO_DISPLAY`](#no-display) | startup | — | No — advice only |
| [`BROWSER_LIBS_MISSING`](#browser-libs-missing) | startup | — | No — advice only |
| [`NODE_MISSING`](#node-missing) | launcher | — | No — advice only |
| [`NPM_INSTALL_FAILED`](#npm-install-failed) | launcher | — | No — advice only |
| [`WDAC_BLOCKED`](#wdac-blocked) | launcher | — | No — advice only |
| [`PKG_MISSING_BROWSERS_JSON`](#pkg-missing-browsers-json) | build | — | No — advice only |
| [`PKG_INSPECTOR_UNAVAILABLE`](#pkg-inspector-unavailable) | build | — | No — advice only |
| [`PKG_NOT_SERIALIZABLE`](#pkg-not-serializable) | build | — | No — advice only |

The `selfHeal` values mean:

- `retry` — the same request may succeed shortly, so the app retries on a timer
- `repair-url` — the address can be corrected and resubmitted automatically
- `restart-server` — needs a terminal command the browser cannot run itself
- `install-browser` — the server can download a browser, but only when you ask it to

---

## Server errors

Returned by the API as JSON: `{ error, code }`. The front end shows the message and looks the code up for guidance.

### SCAN_IN_PROGRESS

> A scan is already running.

**HTTP status:** `409`

**What it means.** The server allows one scan at a time. A scan holds a lock for its whole run, because a single in-memory store and one progress object are shared by all requests.

**Common causes**

- A scan started in another tab or window
- A previous scan has not finished yet

**How to fix it.** Wait for the running scan to finish — the progress bar shows how far along it is. Restarting the server clears the lock if it is genuinely stuck.

**Automatic handling:** `retry`.

### INVALID_URL

> That is not a web address the app can open.

**HTTP status:** `400`

**What it means.** The text could not be parsed as a web address at all.

**Common causes**

- A misspelt or missing hostname, for example "example" with no ".com"
- A scheme other than http or https, such as ftp: or file:
- A typo, or stray spaces inside the address

**How to fix it.** A bare domain is fine — example.com, www.example.com and https://example.com all work. Check the spelling of the address itself.

**Automatic handling:** `repair-url`.

### UNSUPPORTED_SCHEME

> Only http and https website addresses are supported.

**HTTP status:** `400`

**What it means.** The address parsed, but its scheme is not one the app can open — for example file:, ftp: or data:.

**Common causes**

- A local file path was pasted
- An ftp: or other non-web address

**How to fix it.** Use an http:// or https:// address. Local files are not scanned; this tool reads web pages.

**Automatic handling:** none — the app explains it and waits for you.

### NO_BROWSER

> No usable browser was found. Install Chrome or Edge, or download Playwright Chromium with: npx playwright-core install chromium

**HTTP status:** `500`

**What it means.** Scanning needs a real browser to drive. The server checked every known location for this platform and found none.

**Common causes**

- No Chrome, Edge or Chromium installed
- On WSL or Linux, Playwright's Chromium has not been downloaded
- A Windows browser under /mnt/c cannot be used: Playwright drives a browser over Linux process pipes, which WSL interop cannot pass to a Windows .exe

**How to fix it.** On Windows or macOS install Chrome or Edge. On WSL or Linux run: node node_modules/playwright-core/cli.js install chromium

**Automatic handling:** `install-browser`.

### PAGE_TIMEOUT

> The page took too long to load. Try again, or check the address.

**HTTP status:** `500`

**What it means.** The page did not reach the domcontentloaded state within 45 seconds.

**Common causes**

- A slow or unreachable site
- No internet connection
- The address does not exist

**How to fix it.** Check the address in a normal browser tab first. If it loads but slowly, try again — the limit is per attempt, not cumulative.

**Automatic handling:** `retry`.

### SCAN_FAILED

> Could not scan this page.

**HTTP status:** `500`

**What it means.** The browser launched but the scan failed part way through. The underlying reason is appended to the message, because this is the catch-all for anything unexpected.

**Common causes**

- The browser crashed or was closed by hand mid-scan
- Missing Linux libraries, which appear as "error while loading shared libraries"
- The site blocked automated access
- In a packaged build: a bundling problem — see the build codes below

**How to fix it.** Read the text after the colon; that is the real error. If it mentions a shared library, see BROWSER_LIBS_MISSING. If it mentions serialisation, see PKG_NOT_SERIALIZABLE.

**Automatic handling:** none — the app explains it and waits for you.

### IMAGE_EXPIRED

> Image is no longer available. Scan again.

**HTTP status:** `404`

**What it means.** Captured images live only in the server's memory, and each scan clears the store. This id refers to an image from a previous scan or from before a restart.

**Common causes**

- The server restarted
- A newer scan replaced the results
- The page was left open a long time

**How to fix it.** Run the scan again. Results are deliberately not written to disk.

**Automatic handling:** none — the app explains it and waits for you.

---

## Front-end errors

Raised in the page itself, without a request reaching the server.

### SERVER_UNREACHABLE

> Cannot reach the app. The server is not running.

**What it means.** The browser has the page in memory but nothing is listening on port 3719. A loaded page keeps working visually long after the server behind it has gone, which is why this looks like the app "breaking" for no reason. The browser's own wording for this is "Failed to fetch".

**Common causes**

- The server was stopped with Ctrl+C
- The terminal running it was closed
- The server crashed

**How to fix it.** Start it again with ./start-wsl.sh (or npm start), then reload the page with Ctrl+Shift+R.

**Automatic handling:** `restart-server`.

### NOTHING_SELECTED

> Select at least one image first.

**What it means.** Save was pressed with no image ticked among the currently visible types.

**Common causes**

- Everything was unticked
- The only ticked images belong to a type that is filtered out

**How to fix it.** Tick an image, or press Select all. Remember that hiding a type also excludes it from saving.

**Automatic handling:** none — the app explains it and waits for you.

### NO_DIRECTORY_PICKER

> Your browser does not support the native folder picker. Open this app in current Chrome or Edge.

**What it means.** Saving uses the File System Access API (showDirectoryPicker), which writes files straight into a folder you choose. Firefox and Safari do not implement it.

**Common causes**

- Using Firefox or Safari
- A very old Chrome or Edge

**How to fix it.** Open http://127.0.0.1:3719 in Chrome or Edge.

**Automatic handling:** none — the app explains it and waits for you.

### SAVE_READ_FAILED

> Could not read that image. Scan again and retry.

**What it means.** The image bytes were requested during saving but the server no longer had them.

**Common causes**

- The server restarted mid-save
- Another scan cleared the store while saving

**How to fix it.** Scan again, then save without starting another scan in between.

**Automatic handling:** none — the app explains it and waits for you.

### SAVE_CANCELLED

> Saving was cancelled.

**What it means.** The folder picker was dismissed, or write permission was refused. This is a normal outcome, not a fault.

**Common causes**

- Cancel was pressed in the folder picker
- Permission to write was declined

**How to fix it.** Press Save again and choose a folder you have permission to write to.

**Automatic handling:** none — the app explains it and waits for you.

---

## Startup and environment errors

Printed to the terminal when the server starts, or when it tries to launch a browser.

### PORT_IN_USE

> Port 3719 is already in use.

**What it means.** The port is hard-coded, so only one copy of the app can run at a time. Node reports this as EADDRINUSE.

**Common causes**

- The app is already running
- A previous run did not shut down cleanly

**How to fix it.** Find the process and stop it: ss -ltnp | grep 3719 then kill <pid>. Identify it by port, not by name — pkill -f "node server.js" also matches the shell you type it in.

**Automatic handling:** none — the app explains it and waits for you.

### NO_DISPLAY

> No display detected; the visible browser window cannot open.

**What it means.** Scans run with headless: false on purpose, because some sites refuse to run lazy-loaders when they detect a headless browser. A visible window needs a display server, which under WSL means WSLg.

**Common causes**

- WSLg is unavailable
- DISPLAY and WAYLAND_DISPLAY are both unset
- A remote shell with no forwarding

**How to fix it.** Check that echo $DISPLAY prints something. If WSLg is genuinely unavailable, headless: false in server.js can be changed to true, at the cost of missing images on some sites.

**Automatic handling:** none — the app explains it and waits for you.

### BROWSER_LIBS_MISSING

> The browser could not start: required Linux libraries are missing.

**What it means.** Playwright's Chromium needs NSS and ALSA libraries absent from this WSL image. They are unpacked into .wsl-browser-libs and added to LD_LIBRARY_PATH for browser child processes only. Surfaces as "error while loading shared libraries: libnss3.so".

**Common causes**

- .wsl-browser-libs was deleted
- The project was copied to a different machine or user

**How to fix it.** Recreate it as described in WSL-COMPATIBILITY.md: apt-get download libnspr4 libnss3 libasound2t64, then dpkg-deb -x each package into .wsl-browser-libs.

**Automatic handling:** none — the app explains it and waits for you.

---

## Launcher and platform errors

From the start scripts, or from the operating system refusing to run the app.

### NODE_MISSING

> Node.js is required. Install the current LTS release, then run this again.

**What it means.** The launcher could not find node on the PATH.

**Common causes**

- Node.js is not installed
- It is managed by nvm, which has not been sourced in this shell

**How to fix it.** Use ./start-wsl.sh, which sources nvm for you. Otherwise run . ~/.nvm/nvm.sh first, or install Node.js LTS.

**Automatic handling:** none — the app explains it and waits for you.

### NPM_INSTALL_FAILED

> Setup could not finish. Check your internet connection.

**What it means.** npm install failed on first run, so the dependencies are not present.

**Common causes**

- No internet connection
- The npm registry is unreachable
- A proxy is blocking it

**How to fix it.** Check you can reach https://registry.npmjs.org, then run npm install --no-audit --no-fund.

**Automatic handling:** none — the app explains it and waits for you.

### WDAC_BLOCKED

> Windows cannot access the specified device, path, or file.

**What it means.** Windows Defender Application Control is enforced on the machine and permits only executables its policy trusts. This is a refusal to run, not a malware verdict — even Microsoft-signed binaries are blocked once copied out of System32.

**Common causes**

- A managed or corporate machine with an enforced WDAC policy
- The executable is not code-signed

**How to fix it.** Check with PowerShell: (Get-CimInstance -ClassName Win32_DeviceGuard -Namespace root\Microsoft\Windows\DeviceGuard).CodeIntegrityPolicyEnforcementStatus — 2 means enforced. There is no local workaround. Use an unmanaged machine, or run it under WSL instead.

**Automatic handling:** none — the app explains it and waits for you.

---

## Packaging errors

Only seen when building or running a packaged single-file executable.

### PKG_MISSING_BROWSERS_JSON

> Cannot find module playwright-core/browsers.json

**What it means.** In a packaged single-file build, playwright-core loads browsers.json at runtime through its browser registry, so the bundler cannot trace it from the source code.

**Common causes**

- The pkg assets list does not include browsers.json

**How to fix it.** Add node_modules/playwright-core/browsers.json to the pkg.assets array in package.json.

**Automatic handling:** none — the app explains it and waits for you.

### PKG_INSPECTOR_UNAVAILABLE

> Inspector is not available (ERR_INSPECTOR_NOT_AVAILABLE)

**What it means.** playwright-core requires Node's inspector module when it loads, and pkg's prebuilt runtimes are compiled without it. Its only use is !!inspector.url() to detect an attached debugger.

**Common causes**

- Packaging with pkg without applying the inspector patch

**How to fix it.** Run ./package-windows.sh, which re-applies the patch on every build. npm install overwrites it, so it cannot be applied once and forgotten.

**Automatic handling:** none — the app explains it and waits for you.

### PKG_NOT_SERIALIZABLE

> Passed function is not well-serializable!

**What it means.** page.evaluate(fn) works by stringifying the callback and injecting its source into the page. pkg compiles JavaScript to V8 bytecode by default, which destroys Function.prototype.toString(), so there is no source left to inject.

**Common causes**

- Packaging without --no-bytecode

**How to fix it.** Build with --no-bytecode, as the build:win and build:linux scripts already do.

**Automatic handling:** none — the app explains it and waits for you.

---

## Adding a new error

1. Add an entry to `public/errors.js` with a `code`, `message`, `meaning`, `fix`, `where` and `selfHeal`.
2. Return the code from the server: `fail(res, 'YOUR_CODE')`.
3. Run `npm run docs:errors` to update this file.
4. Run `npm test`. The suite checks that every entry is complete, that every error string
   `server.js` can send is documented, and that every code appears here.
