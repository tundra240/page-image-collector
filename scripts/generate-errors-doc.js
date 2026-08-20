/* Regenerates ERRORS.md from public/errors.js, so the document cannot drift out
   of step with the catalogue the app actually uses. Run: npm run docs:errors */
const fs = require('node:fs');
const path = require('node:path');
const { ERRORS } = require('../public/errors.js');

const AREAS = [
  ['server',   'Server errors', 'Returned by the API as JSON: `{ error, code }`. The front end shows the message and looks the code up for guidance.'],
  ['browser',  'Front-end errors', 'Raised in the page itself, without a request reaching the server.'],
  ['startup',  'Startup and environment errors', 'Printed to the terminal when the server starts, or when it tries to launch a browser.'],
  ['launcher', 'Launcher and platform errors', 'From the start scripts, or from the operating system refusing to run the app.'],
  ['build',    'Packaging errors', 'Only seen when building or running a packaged single-file executable.']
];

const esc = s => String(s).replace(/\|/g, '\\|');

let out = `# Error reference

Every error Page Image Collector can report, what it means, and what to do about it.

**This file is generated.** The source of truth is [\`public/errors.js\`](public/errors.js);
regenerate with \`npm run docs:errors\`. \`npm test\` fails if a code here goes missing, so the
two cannot drift apart.

Each error carries a stable \`code\` as well as a message. Messages are written for people and
may be reworded; **codes are the contract** and are what the app matches on.

## Codes at a glance

| Code | Where | HTTP | Can the app help itself? |
| --- | --- | --- | --- |
`;

const order = Object.values(ERRORS).filter(e => e.code !== 'UNKNOWN');
for (const e of order) {
  const heal = e.selfHeal === 'none' ? 'No — advice only' : `Yes — \`${e.selfHeal}\``;
  out += `| [\`${e.code}\`](#${e.code.toLowerCase().replace(/_/g, '-')}) | ${e.where} | ${e.http || '—'} | ${heal} |\n`;
}

out += `\nThe \`selfHeal\` values mean:\n\n`
     + `- \`retry\` — the same request may succeed shortly, so the app retries on a timer\n`
     + `- \`repair-url\` — the address can be corrected and resubmitted automatically\n`
     + `- \`restart-server\` — needs a terminal command the browser cannot run itself\n`
     + `- \`install-browser\` — the server can download a browser, but only when you ask it to\n`;

for (const [area, title, blurb] of AREAS) {
  const items = order.filter(e => e.where === area);
  if (!items.length) continue;
  out += `\n---\n\n## ${title}\n\n${blurb}\n`;
  for (const e of items) {
    out += `\n### ${e.code}\n\n`;
    out += `> ${esc(e.message)}\n\n`;
    if (e.http) out += `**HTTP status:** \`${e.http}\`\n\n`;
    out += `**What it means.** ${e.meaning}\n\n`;
    if (e.causes && e.causes.length) {
      out += `**Common causes**\n\n`;
      for (const c of e.causes) out += `- ${c}\n`;
      out += `\n`;
    }
    out += `**How to fix it.** ${e.fix}\n\n`;
    out += `**Automatic handling:** ${e.selfHeal === 'none'
      ? 'none — the app explains it and waits for you.'
      : `\`${e.selfHeal}\`.`}\n`;
  }
}

out += `\n---\n\n## Adding a new error\n\n`
     + `1. Add an entry to \`public/errors.js\` with a \`code\`, \`message\`, \`meaning\`, \`fix\`, \`where\` and \`selfHeal\`.\n`
     + `2. Return the code from the server: \`fail(res, 'YOUR_CODE')\`.\n`
     + `3. Run \`npm run docs:errors\` to update this file.\n`
     + `4. Run \`npm test\`. The suite checks that every entry is complete, that every error string\n`
     + `   \`server.js\` can send is documented, and that every code appears here.\n`;

fs.writeFileSync(path.join(__dirname, '..', 'ERRORS.md'), out);
console.log(`ERRORS.md written: ${order.length} documented codes`);
