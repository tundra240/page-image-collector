# WSL compatibility changes

This document explains the changes made to run Page Image Collector from WSL without
installing Node.js or a browser in Windows, and without administrator permissions.

Verified on: Ubuntu 26.04 LTS (resolute) under WSL2, kernel 6.18.33.2-microsoft-standard-WSL2,
Node.js v24.19.0 (nvm), playwright-core 1.52/1.62.

## Why the original setup did not work

The Windows batch file expects `node` and `npm` to be installed in Windows.

Windows Chrome and Edge *are* visible from WSL under `/mnt/c`, and the app would happily
find them — but it could not then control them. Playwright drives a browser over Linux
process pipes, and WSL interoperability cannot pass those to a Windows `.exe`. So a Linux
browser is required for the scanning half of the app; pointing the app at `/mnt/c` is not
an option.

The original Linux browser lookup checked only these system-wide paths:

- `/usr/bin/google-chrome`
- `/usr/bin/google-chrome-stable`
- `/usr/bin/microsoft-edge`
- `/usr/bin/chromium`

None existed in this WSL installation.

## What was installed

Playwright Chromium (151.0.7922.34, build 1234) was downloaded into the current WSL user's
cache:

```text
/home/noahforsyth_beija9e/.cache/ms-playwright/
```

This is a per-user download and needs neither `sudo` nor Windows administrator permissions —
which matters here, because this machine has no passwordless `sudo`.

Note the project depends on `playwright-core`, not `playwright`, so the browser download is
driven through the local CLI rather than by fetching an extra package:

```bash
node node_modules/playwright-core/cli.js install chromium
```

### The missing Linux libraries

Running `ldd` against the downloaded Chromium reported **five** unresolved libraries:

```text
libasound.so.2      libnspr4.so      libnss3.so
libnssutil3.so      libsmime3.so
```

These come from three Debian packages (`libnss3` supplies the last three, plus
`libssl3`, `libplc4`, `libplds4`, `libsoftokn3` and `libfreebl3`, which Chromium also uses):

- `libnspr4`
- `libnss3`
- `libasound2t64`

Instead of installing them system-wide, the packages were downloaded and unpacked into the
project:

```bash
mkdir -p .wsl-browser-libs/debs
cd .wsl-browser-libs/debs
apt-get download libnspr4 libnss3 libasound2t64      # works without sudo
for d in *.deb; do dpkg-deb -x "$d" ..; done          # extraction only, no install
```

giving:

```text
.wsl-browser-libs/usr/lib/x86_64-linux-gnu/
```

`ldd` then reports zero unresolved libraries. This keeps the workaround local to the project
and changes nothing about the WSL system.

## A display is required

The app deliberately runs the scanning browser with `headless: false`, because some sites
decline to run lazy-loaders in a headless browser. A visible window needs a display server.

WSLg provides one, and it was present here:

```text
/mnt/wslg exists      DISPLAY=:0      WAYLAND_DISPLAY=wayland-0
```

If a WSL installation has no WSLg, the scan cannot open its window and `headless: false`
would have to be changed to `true` — at the cost of missing images on sites that gate lazy
loading on headless detection.

## Source-code changes

`server.js` makes the following Linux-specific adjustments:

1. `browserCandidates()` appends `chromium.executablePath()` to the Linux list, so the app
   finds Chromium in Playwright's per-user cache. It is appended **last**: a real system
   Chrome or Edge still wins when one is installed, because it ships proprietary codecs and
   a normal profile, where Playwright's build is a stripped test binary. The call is wrapped
   in `try`/`catch` in case no Playwright browser is registered.
2. A new `browserEnvironment()` builds a browser-only environment whose `LD_LIBRARY_PATH`
   includes the private `.wsl-browser-libs` directory.
3. That environment is passed both when opening the application window and when launching
   the automated scanning browser.
4. The missing-browser error now names the Playwright Chromium option and gives the command.

The Node.js server itself receives no global library-path modification.
`browserEnvironment()` returns `process.env` unchanged unless the platform is Linux *and*
the directory exists, so
the private path reaches only browser child processes.

## Running in WSL

A launcher script is provided, because `node` installed via nvm is not on `PATH` until
`nvm.sh` has been sourced — which a non-interactive shell has not done:

```bash
cd "/home/noahforsyth_beija9e/Web-Page-Saver 1.0.2 - Copy"
./start-wsl.sh
```

It sources nvm if needed, installs npm packages on a fresh checkout, downloads Playwright
Chromium if absent, and warns if `.wsl-browser-libs` or a display is missing. `npm start`
still works if `node` is already on `PATH`.

Then visit:

```text
http://127.0.0.1:3719
```

Press `Ctrl+C` in the terminal to stop the server.

If the WSL Playwright browser cache is deleted, download Chromium again without `sudo`:

```bash
node node_modules/playwright-core/cli.js install chromium
```

The private Linux libraries must also remain in `.wsl-browser-libs` unless equivalent
packages are installed system-wide.

## Where saved images go

"Save selected images…" uses the browser's native folder picker, so the browser showing the
UI decides which filesystem you can reach. The UI opens in the Linux Chromium, so the picker
starts in the Linux filesystem.

Windows folders are still reachable through `/mnt/c`, for example
`/mnt/c/Users/NoahForsyth_beija9e/Downloads`. Writing there is slower, because `/mnt/c`
crosses WSL's 9p filesystem bridge rather than the native Linux disk.

## Native Windows compatibility

Native Windows behavior is unchanged. On Windows, `process.platform` is `win32`, so the
application continues to search the standard Windows Chrome and Edge installation
directories, and `browserEnvironment()` returns the environment untouched. The WSL Chromium
lookup and private Linux library path are not used.

The existing Windows launcher can still be used on a machine where Node.js is installed:

```text
Start Image Collector.bat
```

Therefore the same project remains usable in both environments:

- **WSL:** run `./start-wsl.sh` and use Playwright's Linux Chromium.
- **Native Windows:** use the batch launcher or run `npm start`, using installed Windows
  Chrome or Edge.

## Portability note

The `.wsl-browser-libs` directory is part of this project folder, but Playwright Chromium is
stored in the current Linux user's cache. Copying the project to another computer or WSL
account requires downloading Playwright Chromium for that user. The unpacked `.deb` payloads
are also specific to `x86_64` and to this Ubuntu release.

## Cross-origin image recovery (found while testing, fixed)

`server.js` recovers images that a page *declares* but never requests (`data-src`, `srcset`
and similar) by fetching them from inside the page. The original call used a plain
`fetch(url)`, which defaults to CORS mode and is refused by any host that does not send
`access-control-allow-origin`. An `<img src>` is a *no-cors* load and is always permitted,
which is why such images displayed normally but could never be recovered by the sweep.

An end-to-end test collected four of five images; the missing one was declared only via
`data-src` on a host sending no CORS header. The call now passes `{ mode: 'no-cors' }`, which
matches how the browser loads an `<img>`. The response is opaque to the page, but Playwright
reads bodies at the network layer, so it is still captured. The same test now collects all
five.

This bug was not WSL-specific and behaved identically on native Windows.

## Image types and filtering

Capture is no longer restricted to WebP. The response handler stores any `image/*` response,
and `uniqueName()` derives the file extension from the served content type rather than the
URL, because sites routinely serve WebP from a `.jpg` address and a saved file whose
extension lies will not open cleanly.

Filtering happens in the UI, after the scan, rather than at capture time. The scan is the
expensive part — a minute or more of scrolling a real page — so re-scanning merely to change
your mind about a format would be a poor trade. The cost of that choice is that the image cap
counts every type, so a page heavy in one format can reach the cap before other formats are
found; the per-type counts shown on the filter chips make that visible rather than
mysterious.

## Building a single-file Windows executable

`./package-windows.sh` produces `dist/PageImageCollector.exe` — one file containing the
Node runtime, the app, `node_modules` and the `public/` front-end. Nothing needs installing
on the target machine: scanning uses its own Chrome or Edge, and Edge ships with Windows.

Packaging uses `@yao-pkg/pkg` (the maintained fork of the archived `vercel/pkg`). Three
non-obvious things were needed to make Playwright survive bundling, each found by building
the same bundle for Linux and running it locally:

1. **`browsers.json` must be declared as an asset.** playwright-core loads it at runtime
   through its browser registry, so the bundler cannot trace it from the source and the
   binary died with `Cannot find module '.../browsers.json'`.
2. **`playwright-core` requires the `inspector` module at load time**, and pkg's prebuilt
   runtimes are compiled without it (`ERR_INSPECTOR_NOT_AVAILABLE`). Its only use is
   `!!inspector.url()` to detect an attached JS debugger, so the build patches that one line
   to fall back to an undefined url — which is the correct answer when no debugger exists.
   `npm install` overwrites the patch, so `package-windows.sh` re-applies it every build.
3. **`--no-bytecode` is required.** By default pkg compiles JavaScript to V8 bytecode, which
   destroys `Function.prototype.toString()`. `page.evaluate(fn)` works by stringifying the
   callback and injecting the source into the page, so under bytecode every call failed with
   `Passed function is not well-serializable!`.

`server.js` also derives `APP_DIR` from `process.execPath` when `process.pkg` is set, because
inside a packaged binary `__dirname` points into a virtual snapshot rather than the real
filesystem. Anything read from disk — such as `.wsl-browser-libs` — has to be located
relative to the executable instead.

### What is verified, and what is not

The equivalent Linux binary was built with the same configuration and run here: it starts,
serves the front-end from inside the bundle, launches the browser and completes a full scan
(6 images across 5 types). The Windows binary is confirmed to be a `PE32+ x86-64` executable
with the app and front-end embedded, but it has **not been executed**, because a Windows
`.exe` cannot run under WSL and this machine has no Windows Node install.

