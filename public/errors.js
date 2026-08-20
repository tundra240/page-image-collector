/* ============================================================================
   Error catalogue — the single source of truth for every failure the app can
   report.

   Errors used to be plain strings. A string can be shown to a person but it
   cannot be reasoned about: nothing can reliably decide what to do about
   "Could not scan this page". So every failure now carries a stable `code`,
   and this file maps that code to what it means, how to fix it, and whether
   the app can repair it without help.

   Loaded by both sides: the browser gets it as a <script> tag (window.APP_ERRORS)
   and the server gets it through require(). One catalogue, no drift.
   ========================================================================== */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.APP_ERRORS = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  /* selfHeal values, and what the front end does with each:
       'none'            nothing automatic is safe or possible — show the advice
       'retry'           the same request may succeed shortly; retry on a timer
       'repair-url'      the address can be corrected and resubmitted
       'restart-server'  needs a terminal command the browser cannot run
       'install-browser' the server can download a browser, but only when asked  */

  const ERRORS = {

    /* ---------------------------------------------------------------- server */

    SCAN_IN_PROGRESS: {
      code: 'SCAN_IN_PROGRESS',
      where: 'server',
      http: 409,
      message: 'A scan is already running.',
      meaning: 'The server allows one scan at a time. A scan holds a lock for its whole run, '
             + 'because a single in-memory store and one progress object are shared by all requests.',
      causes: ['A scan started in another tab or window', 'A previous scan has not finished yet'],
      fix: 'Wait for the running scan to finish — the progress bar shows how far along it is. '
         + 'Restarting the server clears the lock if it is genuinely stuck.',
      selfHeal: 'retry'
    },

    INVALID_URL: {
      code: 'INVALID_URL',
      where: 'server',
      http: 400,
      message: 'That is not a web address the app can open.',
      meaning: 'The text could not be parsed as a web address at all.',
      causes: [
        'A misspelt or missing hostname, for example "example" with no ".com"',
        'A scheme other than http or https, such as ftp: or file:',
        'A typo, or stray spaces inside the address'
      ],
      // Deliberately does NOT say "include the scheme". It used to, which was wrong
      // advice the moment repairUrl started filling the scheme in, and telling people
      // to type https:// made a working feature look like a missing one.
      fix: 'A bare domain is fine — example.com, www.example.com and https://example.com all work. Check the spelling of the address itself.',
      selfHeal: 'repair-url'
    },

    UNSUPPORTED_SCHEME: {
      code: 'UNSUPPORTED_SCHEME',
      where: 'server',
      http: 400,
      message: 'Only http and https website addresses are supported.',
      meaning: 'The address parsed, but its scheme is not one the app can open — for example '
             + 'file:, ftp: or data:.',
      causes: ['A local file path was pasted', 'An ftp: or other non-web address'],
      fix: 'Use an http:// or https:// address. Local files are not scanned; this tool reads web pages.',
      selfHeal: 'none'
    },

    NO_BROWSER: {
      code: 'NO_BROWSER',
      where: 'server',
      http: 500,
      message: 'No usable browser was found. Install Chrome or Edge, or download Playwright Chromium with: npx playwright-core install chromium',
      meaning: 'Scanning needs a real browser to drive. The server checked every known location '
             + 'for this platform and found none.',
      causes: [
        'No Chrome, Edge or Chromium installed',
        'On WSL or Linux, Playwright\'s Chromium has not been downloaded',
        'A Windows browser under /mnt/c cannot be used: Playwright drives a browser over Linux '
        + 'process pipes, which WSL interop cannot pass to a Windows .exe'
      ],
      fix: 'On Windows or macOS install Chrome or Edge. On WSL or Linux run: '
         + 'node node_modules/playwright-core/cli.js install chromium',
      selfHeal: 'install-browser'
    },

    PAGE_TIMEOUT: {
      code: 'PAGE_TIMEOUT',
      where: 'server',
      http: 500,
      message: 'The page took too long to load. Try again, or check the address.',
      meaning: 'The page did not reach the domcontentloaded state within 45 seconds.',
      causes: ['A slow or unreachable site', 'No internet connection', 'The address does not exist'],
      fix: 'Check the address in a normal browser tab first. If it loads but slowly, try again — '
         + 'the limit is per attempt, not cumulative.',
      selfHeal: 'retry'
    },

    SCAN_FAILED: {
      code: 'SCAN_FAILED',
      where: 'server',
      http: 500,
      message: 'Could not scan this page.',
      meaning: 'The browser launched but the scan failed part way through. The underlying reason '
             + 'is appended to the message, because this is the catch-all for anything unexpected.',
      causes: [
        'The browser crashed or was closed by hand mid-scan',
        'Missing Linux libraries, which appear as "error while loading shared libraries"',
        'The site blocked automated access',
        'In a packaged build: a bundling problem — see the build codes below'
      ],
      fix: 'Read the text after the colon; that is the real error. If it mentions a shared library, '
         + 'see BROWSER_LIBS_MISSING. If it mentions serialisation, see PKG_NOT_SERIALIZABLE.',
      selfHeal: 'none'
    },

    IMAGE_EXPIRED: {
      code: 'IMAGE_EXPIRED',
      where: 'server',
      http: 404,
      message: 'Image is no longer available. Scan again.',
      meaning: 'Captured images live only in the server\'s memory, and each scan clears the store. '
             + 'This id refers to an image from a previous scan or from before a restart.',
      causes: ['The server restarted', 'A newer scan replaced the results', 'The page was left open a long time'],
      fix: 'Run the scan again. Results are deliberately not written to disk.',
      selfHeal: 'none'
    },

    /* --------------------------------------------------------------- browser */

    SERVER_UNREACHABLE: {
      code: 'SERVER_UNREACHABLE',
      where: 'browser',
      message: 'Cannot reach the app. The server is not running.',
      meaning: 'The browser has the page in memory but nothing is listening on port 3719. '
             + 'A loaded page keeps working visually long after the server behind it has gone, '
             + 'which is why this looks like the app "breaking" for no reason. The browser\'s own '
             + 'wording for this is "Failed to fetch".',
      causes: ['The server was stopped with Ctrl+C', 'The terminal running it was closed', 'The server crashed'],
      fix: 'Start it again with ./start-wsl.sh (or npm start), then reload the page with Ctrl+Shift+R.',
      selfHeal: 'restart-server'
    },

    NOTHING_SELECTED: {
      code: 'NOTHING_SELECTED',
      where: 'browser',
      message: 'Select at least one image first.',
      meaning: 'Save was pressed with no image ticked among the currently visible types.',
      causes: ['Everything was unticked', 'The only ticked images belong to a type that is filtered out'],
      fix: 'Tick an image, or press Select all. Remember that hiding a type also excludes it from saving.',
      selfHeal: 'none'
    },

    NO_DIRECTORY_PICKER: {
      code: 'NO_DIRECTORY_PICKER',
      where: 'browser',
      message: 'Your browser does not support the native folder picker. Open this app in current Chrome or Edge.',
      meaning: 'Saving uses the File System Access API (showDirectoryPicker), which writes files '
             + 'straight into a folder you choose. Firefox and Safari do not implement it.',
      causes: ['Using Firefox or Safari', 'A very old Chrome or Edge'],
      fix: 'Open http://127.0.0.1:3719 in Chrome or Edge.',
      selfHeal: 'none'
    },

    SAVE_READ_FAILED: {
      code: 'SAVE_READ_FAILED',
      where: 'browser',
      message: 'Could not read that image. Scan again and retry.',
      meaning: 'The image bytes were requested during saving but the server no longer had them.',
      causes: ['The server restarted mid-save', 'Another scan cleared the store while saving'],
      fix: 'Scan again, then save without starting another scan in between.',
      selfHeal: 'none'
    },

    SAVE_CANCELLED: {
      code: 'SAVE_CANCELLED',
      where: 'browser',
      message: 'Saving was cancelled.',
      meaning: 'The folder picker was dismissed, or write permission was refused. This is a normal '
             + 'outcome, not a fault.',
      causes: ['Cancel was pressed in the folder picker', 'Permission to write was declined'],
      fix: 'Press Save again and choose a folder you have permission to write to.',
      selfHeal: 'none'
    },

    /* --------------------------------------------------------------- startup */

    PORT_IN_USE: {
      code: 'PORT_IN_USE',
      where: 'startup',
      message: 'Port 3719 is already in use.',
      meaning: 'The port is hard-coded, so only one copy of the app can run at a time. Node reports '
             + 'this as EADDRINUSE.',
      causes: ['The app is already running', 'A previous run did not shut down cleanly'],
      fix: 'Find the process and stop it: ss -ltnp | grep 3719 then kill <pid>. Identify it by port, '
         + 'not by name — pkill -f "node server.js" also matches the shell you type it in.',
      selfHeal: 'none'
    },

    NO_DISPLAY: {
      code: 'NO_DISPLAY',
      where: 'startup',
      message: 'No display detected; the visible browser window cannot open.',
      meaning: 'Scans run with headless: false on purpose, because some sites refuse to run '
             + 'lazy-loaders when they detect a headless browser. A visible window needs a display '
             + 'server, which under WSL means WSLg.',
      causes: ['WSLg is unavailable', 'DISPLAY and WAYLAND_DISPLAY are both unset', 'A remote shell with no forwarding'],
      fix: 'Check that echo $DISPLAY prints something. If WSLg is genuinely unavailable, headless: false '
         + 'in server.js can be changed to true, at the cost of missing images on some sites.',
      selfHeal: 'none'
    },

    BROWSER_LIBS_MISSING: {
      code: 'BROWSER_LIBS_MISSING',
      where: 'startup',
      message: 'The browser could not start: required Linux libraries are missing.',
      meaning: 'Playwright\'s Chromium needs NSS and ALSA libraries absent from this WSL image. They '
             + 'are unpacked into .wsl-browser-libs and added to LD_LIBRARY_PATH for browser child '
             + 'processes only. Surfaces as "error while loading shared libraries: libnss3.so".',
      causes: ['.wsl-browser-libs was deleted', 'The project was copied to a different machine or user'],
      fix: 'Recreate it as described in WSL-COMPATIBILITY.md: apt-get download libnspr4 libnss3 '
         + 'libasound2t64, then dpkg-deb -x each package into .wsl-browser-libs.',
      selfHeal: 'none'
    },

    /* -------------------------------------------------------------- launcher */

    NODE_MISSING: {
      code: 'NODE_MISSING',
      where: 'launcher',
      message: 'Node.js is required. Install the current LTS release, then run this again.',
      meaning: 'The launcher could not find node on the PATH.',
      causes: ['Node.js is not installed', 'It is managed by nvm, which has not been sourced in this shell'],
      fix: 'Use ./start-wsl.sh, which sources nvm for you. Otherwise run . ~/.nvm/nvm.sh first, or '
         + 'install Node.js LTS.',
      selfHeal: 'none'
    },

    NPM_INSTALL_FAILED: {
      code: 'NPM_INSTALL_FAILED',
      where: 'launcher',
      message: 'Setup could not finish. Check your internet connection.',
      meaning: 'npm install failed on first run, so the dependencies are not present.',
      causes: ['No internet connection', 'The npm registry is unreachable', 'A proxy is blocking it'],
      fix: 'Check you can reach https://registry.npmjs.org, then run npm install --no-audit --no-fund.',
      selfHeal: 'none'
    },

    WDAC_BLOCKED: {
      code: 'WDAC_BLOCKED',
      where: 'launcher',
      message: 'Windows cannot access the specified device, path, or file.',
      meaning: 'Windows Defender Application Control is enforced on the machine and permits only '
             + 'executables its policy trusts. This is a refusal to run, not a malware verdict — '
             + 'even Microsoft-signed binaries are blocked once copied out of System32.',
      causes: ['A managed or corporate machine with an enforced WDAC policy', 'The executable is not code-signed'],
      fix: 'Check with PowerShell: (Get-CimInstance -ClassName Win32_DeviceGuard -Namespace '
         + 'root\\Microsoft\\Windows\\DeviceGuard).CodeIntegrityPolicyEnforcementStatus — 2 means enforced. '
         + 'There is no local workaround. Use an unmanaged machine, or run it under WSL instead.',
      selfHeal: 'none'
    },

    /* ----------------------------------------------------------------- build */

    PKG_MISSING_BROWSERS_JSON: {
      code: 'PKG_MISSING_BROWSERS_JSON',
      where: 'build',
      message: 'Cannot find module playwright-core/browsers.json',
      meaning: 'In a packaged single-file build, playwright-core loads browsers.json at runtime '
             + 'through its browser registry, so the bundler cannot trace it from the source code.',
      causes: ['The pkg assets list does not include browsers.json'],
      fix: 'Add node_modules/playwright-core/browsers.json to the pkg.assets array in package.json.',
      selfHeal: 'none'
    },

    PKG_INSPECTOR_UNAVAILABLE: {
      code: 'PKG_INSPECTOR_UNAVAILABLE',
      where: 'build',
      message: 'Inspector is not available (ERR_INSPECTOR_NOT_AVAILABLE)',
      meaning: 'playwright-core requires Node\'s inspector module when it loads, and pkg\'s prebuilt '
             + 'runtimes are compiled without it. Its only use is !!inspector.url() to detect an '
             + 'attached debugger.',
      causes: ['Packaging with pkg without applying the inspector patch'],
      fix: 'Run ./package-windows.sh, which re-applies the patch on every build. npm install '
         + 'overwrites it, so it cannot be applied once and forgotten.',
      selfHeal: 'none'
    },

    PKG_NOT_SERIALIZABLE: {
      code: 'PKG_NOT_SERIALIZABLE',
      where: 'build',
      message: 'Passed function is not well-serializable!',
      meaning: 'page.evaluate(fn) works by stringifying the callback and injecting its source into '
             + 'the page. pkg compiles JavaScript to V8 bytecode by default, which destroys '
             + 'Function.prototype.toString(), so there is no source left to inject.',
      causes: ['Packaging without --no-bytecode'],
      fix: 'Build with --no-bytecode, as the build:win and build:linux scripts already do.',
      selfHeal: 'none'
    },

    /* -------------------------------------------------------------- fallback */

    UNKNOWN: {
      code: 'UNKNOWN',
      where: 'browser',
      message: 'Something went wrong.',
      meaning: 'No catalogue entry matched this error, so it is either new or came from outside the app.',
      causes: ['An error the catalogue does not cover yet'],
      fix: 'Read the original message for detail. If it is reproducible, add an entry to '
         + 'public/errors.js and ERRORS.md so it is recognised next time.',
      selfHeal: 'none'
    }
  };

  /** Returns the catalogue entry for a code, or the UNKNOWN fallback. Never throws. */
  function lookup(code) {
    return (code && ERRORS[code]) || ERRORS.UNKNOWN;
  }

  /**
   * True for addresses on this machine or this network, which are almost never
   * served over TLS. Guessing https for them yields a refused connection rather
   * than a working scan.
   */
  function isLocalHostname(hostname) {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
    if (host === '::1' || host === '0.0.0.0') return true;
    if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
    return /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  }

  /**
   * Attempts to turn user input into a usable http(s) URL.
   * Returns the repaired URL, or null when the input cannot be salvaged —
   * guessing wildly would be worse than reporting a clear failure.
   */
  /* A leading attempt at "http://" or "https://" that lost a character or two.
     Hand-typing it goes wrong in a small number of predictable ways: one slash
     instead of two, a missing colon, no slashes at all, or a dropped letter in the
     scheme itself.

     Deliberately an explicit list of misspellings rather than a fuzzy match. A rule
     along the lines of "strip anything up to the first colon" would happily accept
     javascript: and file: as well, so the exactness is the security property. A
     hostname that merely begins with these letters - http.com, httpsite.com - has no
     colon or double slash after it and so cannot match. */
  const SCHEME_TYPO = /^(https|http|htps|htp|ttps|ttp)?(?::\/{0,2}|\/{2})(?=[^\s\/])/i;

  function repairUrl(value) {
    let raw = String(value == null ? '' : value).trim();
    if (!raw) return null;

    // Repair a mangled scheme before anything else, then let the ordinary paths below
    // accept or reject the result. Whether the user wrote http or https is preserved:
    // the typo gets fixed, their stated intent does not get overridden.
    const typo = raw.match(SCHEME_TYPO);
    if (typo && !/^https?:\/\//i.test(raw)) {
      const secure = !typo[1] || /s$/i.test(typo[1]);
      raw = (secure ? 'https://' : 'http://') + raw.slice(typo[0].length);
    }

    // An explicit scheme is respected exactly as written. The test is for '://' rather
    // than parseability, because new URL('localhost:3000') succeeds — it reads
    // 'localhost' as the scheme and '3000' as the path — which would otherwise get a
    // perfectly good local address rejected as an unsupported scheme.
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) {
      try {
        const parsed = new URL(raw);
        return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : null;
      } catch {
        return null;
      }
    }

    // Whitespace inside means this is prose, not an address.
    if (/\s/.test(raw)) return null;

    try {
      const probe = new URL('https://' + raw);
      const local = isLocalHostname(probe.hostname);
      // A hostname with no dot is usually a typo — unless it is a local name such
      // as localhost, where no dot is normal.
      if (!probe.hostname.includes('.') && !local) return null;
      return local ? new URL('http://' + raw).href : probe.href;
    } catch {
      return null;
    }
  }

  /** True when retrying the identical request unchanged has a real chance of working. */
  function isRetryable(code) {
    return lookup(code).selfHeal === 'retry';
  }

  return { ERRORS, lookup, repairUrl, isRetryable, isLocalHostname };
});
