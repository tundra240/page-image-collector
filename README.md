# Page Image Collector

Give it a web page address. It opens that page in a real browser it drives automatically,
scrolls the whole thing to trigger lazy-loaded images, collects every image the page loads,
and lets you filter by file type and save the ones you want.

Everything happens on your own machine. The app listens on `127.0.0.1` only — it is never
exposed to your network or the internet, and no images or addresses are sent anywhere.

- **How it works internally:** [ARCHITECTURE.md](ARCHITECTURE.md)
- **Every error it can report, and what to do:** [ERRORS.md](ERRORS.md)
- **Why the WSL setup looks unusual:** [WSL-COMPATIBILITY.md](WSL-COMPATIBILITY.md)

---

## Start it in 30 seconds

| Your machine | Do this | Then |
|---|---|---|
| **Linux / WSL** | `./start-wsl.sh` in a terminal, from the project folder | Keep the terminal open; `Ctrl+C` stops it |
| **Windows, no Node.js** | Double-click `PageImageCollector.exe` | Closing the console window stops it |
| **Windows, Node.js installed** | Double-click `Start Image Collector.bat` | Closing the console window stops it |
| **macOS** | `chmod +x` once, then double-click `Start Image Collector.command` | `Ctrl+C` in the window stops it |

Whichever route you take, the app ends up at the same place: **<http://127.0.0.1:3719>**, and a
browser window opens there by itself. Each platform is covered in full below.

---

## Requirements

| | Needed | Notes |
|---|---|---|
| **All platforms** | Chrome, Edge, or Chromium | Needed twice: to scan pages, and for the native folder picker when saving |
| **Windows / macOS** | Node.js 20 or newer | Not needed if you use the packaged `.exe` |
| **WSL / Linux** | Node.js 20 or newer, plus WSLg | The launcher downloads a Linux Chromium for you if none is installed |

On Windows, Edge ships with the OS, so there is normally no browser to install.

**Why Node 20 specifically.** It is not a guess or a general preference for something recent:
`playwright-core` declares `"engines": { "node": ">=20" }` in its own `package.json`, so anything
older is unsupported by the dependency itself. Node 22 or 24 are both fine — this project is
developed on **v24.19.0**. The packaged `.exe` embeds a Node 22 runtime, which is why Option A
below needs no Node.js on the machine at all.

Check what you have with `node -v`. If that prints nothing on WSL, Node is installed but not on
your `PATH` yet — see the launcher note below, and use `./start-wsl.sh`.

---

## Running it on WSL or Linux

Open a terminal, go to the project folder, and run the launcher:

```bash
cd "/path/to/Web-Page-Saver 1.0.2 - Copy"   # on this machine: /home/noahforsyth_beija9e/...
./start-wsl.sh
```

If the launcher will not run at all with `permission denied`, its executable bit was lost in a
copy. Restore it once with `chmod +x start-wsl.sh`.

Wait for this line:

```
Page Image Collector is running at http://127.0.0.1:3719
```

A browser window opens by itself, pointed at the app. If you would rather use your own tab,
go to `http://127.0.0.1:3719`.

**Two things to expect:**

- **Keep the terminal open.** The server runs *inside* it. Press `Ctrl+C` to stop the app.
- **The terminal will look frozen** after that line. It isn't — a server just sits and waits.
  Open a second terminal if you need one.

`./start-wsl.sh` exists because Node installed via **nvm** is not on your `PATH` until
`nvm.sh` has been sourced, which a fresh or non-interactive shell has not done. The script
sources it for you, installs npm packages on a fresh checkout, downloads Playwright's Chromium
if it is missing, and warns you if a display or the browser libraries are absent.

If `node` is already on your `PATH`, `npm start` does the same job.

### Common problems on WSL

| Symptom | Cause and fix |
|---|---|
| `127.0.0.1 refused to connect` | The server is not running. `cd` alone does not start it — run `./start-wsl.sh` |
| `EADDRINUSE: address already in use` | An old copy is still running. Find and stop it: `ss -ltnp \| grep 3719` then `kill <pid>` |
| `command not found: node` | nvm is not loaded. Use `./start-wsl.sh`, or run `. ~/.nvm/nvm.sh` first |
| Browser window never appears | No display. Check `echo $DISPLAY` returns something; WSLg is required |
| `No usable browser was found` | Run `node node_modules/playwright-core/cli.js install chromium` |
| Browser fails to start | `.wsl-browser-libs/` is missing — see [WSL-COMPATIBILITY.md](WSL-COMPATIBILITY.md) |

### On a normal Linux desktop, not WSL

`./start-wsl.sh` is the right launcher there too — despite the name, nothing in it is
WSL-specific. It sources nvm if needed, installs packages, fetches Chromium if absent, and
starts the server. Two differences are worth knowing:

- **You already have a display**, so the WSLg warning never applies and the automated browser
  window just opens.
- **`.wsl-browser-libs/` is not needed.** It only exists to supply NSS and ALSA libraries that
  this particular WSL image is missing. On a desktop distribution those come with the system, so
  the launcher's "`.wsl-browser-libs` is missing" note is harmless — ignore it.

If you would rather use your distribution's own browser than let Playwright download one, install
it first and the app will prefer it, because system browsers are checked ahead of the Playwright
fallback:

```bash
sudo apt install chromium        # Debian / Ubuntu
sudo dnf install chromium        # Fedora
```

The app looks for `/usr/bin/google-chrome`, `/usr/bin/google-chrome-stable`,
`/usr/bin/microsoft-edge` and `/usr/bin/chromium`, in that order.

---

## Running it on Windows

### Option A — the packaged executable (no Node.js needed)

Double-click **`PageImageCollector.exe`**. A console window opens, then a browser at
`http://127.0.0.1:3719`. Closing the console stops the app.

Build it from a WSL checkout with:

```bash
./package-windows.sh
```

That produces `dist/PageImageCollector.exe` (~63MB) and a smaller zip alongside it. The exe
contains the Node runtime, the app and the front-end, so nothing needs installing on the
target machine.

**Two warnings you may hit:**

- **"Windows protected your PC" / unknown publisher.** Expected — the exe is not
  code-signed. Choose *More info → Run anyway*.
- **"Access is denied"** and it refuses to start at all. This means the machine enforces
  **WDAC** (Windows Defender Application Control), which only permits executables its policy
  trusts. Self-built executables are blocked no matter what they contain — even Microsoft's
  own signed binaries are blocked once copied out of `System32`. There is no local workaround;
  use Option B, or ask IT.

  To check whether a machine enforces it, in PowerShell:

  ```powershell
  (Get-CimInstance -ClassName Win32_DeviceGuard -Namespace root\Microsoft\Windows\DeviceGuard).CodeIntegrityPolicyEnforcementStatus
  ```

  `2` means enforced.

### Option B — with Node.js installed

Install the current **Node.js LTS** from <https://nodejs.org/>, then double-click
**`Start Image Collector.bat`**.

The first launch runs `npm install`; later launches skip it. No browser is downloaded — it
uses your installed Chrome or Edge.

This is the option that works on locked-down machines, because Node.js installs into
`Program Files`, which such policies normally trust.

**To stop it**, close the console window the `.bat` opened, or press `Ctrl+C` in it. The same
applies to the `.exe` in Option A. As on WSL, that window *is* the server — it will sit there
looking idle after printing its startup line, and that is the app working normally, not a hang.
If a later launch reports `EADDRINUSE`, a previous console is still open somewhere; close it, or
find the holder of the port in PowerShell with:

```powershell
Get-NetTCPConnection -LocalPort 3719 | Select-Object OwningProcess
```

### Copying the project from WSL to Windows

Do **not** copy the folder as-is. This checkout contains files with `:` in their names
(`README.md:Zone.Identifier` and similar — Windows metadata that WSL turned into real files).
**NTFS cannot store a colon in a filename**, so the copy will fail or silently skip files.

`./package-windows.sh` strips them for you. If you copy by hand, exclude them:

```bash
rsync -a --exclude='*:*' --exclude='.wsl-browser-libs' \
  ./ /mnt/c/Users/<you>/Desktop/PageImageCollector/
```

Also skip `.wsl-browser-libs/` — those are Linux libraries, meaningless on Windows.

---

## Running it on macOS

Once only, make the launcher executable:

```bash
chmod +x "Start Image Collector.command"
```

Then double-click it. Requires Node.js LTS and Chrome or Edge in `/Applications`.

---

## The look

The background is green topographic contour lines flowing behind the page: nested loops that
swell, split and merge as the landscape under them moves, with a scroll-linked drift so it feels
attached to the content rather than pinned behind it.

**Moving the cursor stirs it.** Drag the pointer across an empty part of the page and the
contour lines near it are pulled along, then flow back once you stop — like drawing a finger
through a liquid. Nothing is drawn under the cursor and no shape follows it around: the lines
already there are simply displaced. Hold still and there is no trace of it at all.

It holds 60 fps even while a scan is running, which took some care — a contour has to be *found*
every frame rather than merely moved, so unlike the rest of the interface this one is drawn on a
canvas rather than in CSS. It uses about 5% of a frame at 1080p, and the cursor tracking adds
nothing measurable on top. The lines are stitched into continuous curves rather than drawn cell by
cell, which is what keeps them smooth instead of faceted; the techniques were chosen by
measurement rather than by eye, and `ARCHITECTURE.md` has the numbers.

If your system is set to reduce motion, all of it stops: the lines rest in a still composition,
and the scroll drift and cursor tracking are both switched off.

## Shipping it to Windows

Two routes, both self-contained — neither needs Node.js installed on the target machine, and
both use the machine's own Chrome or Edge for scanning (Edge ships with Windows).

| | Single file | Folder |
|---|---|---|
| Build | `./package-windows.sh` | `./package-folder.sh` |
| Result | `dist/PageImageCollector.exe` (62 MB) | `dist/PageImageCollector/` (102 MB) |
| Zipped | 22 MB | 36 MB |
| Run it | double-click the `.exe` | double-click `Start Image Collector.bat` |
| Editable afterwards | no — rebuild for any change | **yes** — edit a file, refresh the browser |

The **single file** is tidier to send to somebody. The **folder** keeps everything as ordinary
files, so `public/style.css` and the rest can be edited in place with no rebuild; it bundles its
own Node runtime in `runtime\node.exe`.

Keep the folder together — the `.bat` needs the files beside it.

Windows will warn that the file is unrecognised, because neither is code-signed. That is expected
for a self-built program: choose **More info → Run anyway**. On a work machine with application
control enforced, neither will run at all, and that is the policy doing its job rather than a
fault in the build.

## The home screen

Before a scan there are three step cards explaining what the app does, and a note about what it
cannot capture. Once you have scanned something, a **Recent** row appears above them — click an
address to put it back in the box.

Those addresses are the **only** thing kept between runs. They live in your browser's
`localStorage` on this machine, never leave it, and **Clear** beside the row removes them.
Captured images are never written to disk; they stay in memory until you save them yourself.

The whole panel gives way to the results grid after a scan, and comes back when you click the
title.

## Using the app

1. **Paste or type a page address** into the box. The scheme is optional — all of these work
   and mean the same thing:

   | You can type | The app uses |
   |---|---|
   | `example.com` | `https://example.com/` |
   | `www.example.com` | `https://www.example.com/` |
   | `https://example.com` | `https://example.com/` (unchanged) |
   | `example.com/gallery` | `https://example.com/gallery` |
   | `localhost:3000`, `127.0.0.1:8124` | `http://…` — local addresses are rarely served over TLS |

   Common typos in the scheme are repaired too: `https:/example.com` (one slash),
   `https//example.com` (no colon) and `htps://example.com` all resolve correctly. Whether you
   wrote `http` or `https` is preserved rather than overridden.

   Once you pause typing, a line under the box shows the address that will actually be used, so
   you can check it before starting a scan. Addresses the app cannot repair — a scheme such as
   `ftp:` or a hostname with no dot — are reported instead of guessed at.
2. **Set an image cap** (1–5,000, default 500). This is a safety limit — image data is held in
   memory, so a very high cap on an image-heavy page can use a lot of RAM.

   Or tick **Auto cap** to take everything the page has instead of stopping at a fixed number.
   The true total cannot be known in advance, because lazy-loaded images only exist once they
   have been scrolled into view — so auto cap imposes no limit of its own and reports the count
   as it discovers it, with a hard backstop at 5,000 to protect memory.

   While scanning, that figure is shown with a tilde (`12 of ~48 images`) because it counts
   image *candidates* found in the page. Some candidates turn out to be missing files or not
   images at all, which is only knowable after fetching them, so the final count can be lower.
3. **Press "Find images."** A second browser window opens and scrolls the page by itself. Let
   it work; that scrolling is what makes lazy-loaded images appear. The progress bar tracks its
   position down the page and how many images it has found.
4. **Filter by type.** The results show **Show types** chips — one per format actually found,
   each with a count, for example `WebP 12 · PNG 4 · JPEG 7`. Untick a type to hide it.
   Hidden types are excluded from saving, so you cannot accidentally save something you
   filtered out.
5. **Choose images.** Everything starts selected. Click a card anywhere to deselect it — it
   **greys out and fades**, so what you are about to save is obvious at a glance rather than
   needing you to read every tick box. Hovering a greyed-out card lifts it most of the way back,
   as a hint that clicking will restore it.

   `Select all` and `Select none` act only on what is currently visible.
6. **To start over, click the title** — *Page Image Collector*. It clears the address and the
   results and puts the cursor back in the address box. The image cap and Auto cap are left as
   you set them, since those are settings for the next scan rather than leftovers from the last
   one. It does nothing while a scan is running, because a scan cannot be cancelled — the
   cursor turns to a wait pointer to say so.
7. **Press "Save selected images…"**, choose a folder in the picker, and the files are written
   straight there. Names are prefixed by page order — `001-`, `002-` — and the file extension
   comes from what the server actually sent, not from the URL, because sites often serve WebP
   from a `.jpg` address.

### Where saved images can go

Saving uses the browser's own folder picker, so **whichever browser shows the app decides
which filesystem you can reach**.

- **Windows:** any normal Windows folder.
- **WSL:** the picker opens in the Linux filesystem. You can still reach Windows folders
  through `/mnt/c`, for example `/mnt/c/Users/<you>/Downloads` — just slower, because `/mnt/c`
  crosses WSL's filesystem bridge.

### If saving is unavailable

The message *"Your browser does not support the native folder picker"* means you are not in a
Chromium-family browser. The File System Access API is a Chrome/Edge feature; Firefox and
Safari do not have it.

---

## General troubleshooting

| Symptom | What it means |
|---|---|
| `A scan is already running` | Only one scan at a time. Wait for it, or restart the server |
| `The page took too long to load` | The page exceeded the 45-second load timeout |
| `Image is no longer available. Scan again.` | The server restarted. Images live in memory only |
| No images found on a page you can see images on | They may be `<canvas>` or CSS-generated content, which cannot be captured as files |
| Fewer images than expected | The cap counts **all** types — a page heavy in one format can hit it before others are reached. Raise the cap |
| Scan is very slow | Expected on long pages: it pauses ~0.5s per scroll step so lazy-loading can fire |

---

## Developer notes

```bash
npm test               # run the test suite (no dependencies; uses node --test)
npm run docs:errors    # regenerate ERRORS.md from the error catalogue
npm start              # run the server directly (needs node on PATH)
npm run build:win      # single-file Windows executable
npm run build:linux    # same bundle for Linux — useful for testing the packaging
./package-windows.sh   # full Windows build: patch, build, verify, zip
```

`build:linux` exists specifically so the packaging can be **tested**: it is the same bundle
with a Linux runtime embedded, so it can actually be run and debugged. That is how three
separate bundling bugs were found and fixed — see
[ARCHITECTURE.md §12](ARCHITECTURE.md) for the details.
