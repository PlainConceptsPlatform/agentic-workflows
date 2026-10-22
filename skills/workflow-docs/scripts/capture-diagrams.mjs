// Captures each archify diagram's SVG as a WebP, in dark and light, for the Pages landing page.
// Serve docs/ first (for example `python -m http.server 8765 --directory docs`), then:
//   node skills/workflow-docs/scripts/capture-diagrams.mjs http://localhost:8765/diagrams docs/assets/diagrams router route-chain agent-triage ...
// Set CHROME to the browser binary when it is not in the default location.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [base, out, ...stems] = process.argv.slice(2);
if (!base || !out || stems.length === 0) {
  console.error('usage: capture-diagrams.mjs <diagramsBaseUrl> <outDir> <stem...>');
  process.exit(2);
}

const defaults = {
  win32: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  linux: 'google-chrome',
};
const port = 9333;
const chrome = spawn(process.env.CHROME ?? defaults[process.platform] ?? 'google-chrome', [
  '--headless=new', `--remote-debugging-port=${port}`, '--no-first-run', '--hide-scrollbars',
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'capture-diagrams-'))}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    target = list.find((t) => t.type === 'page');
  } catch {}
}
if (!target) {
  chrome.kill();
  throw new Error('Chrome did not expose a page target; set CHROME to the browser binary');
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve) => ws.addEventListener('open', resolve));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});
const send = (method, params = {}) => new Promise((resolve) => {
  const callId = ++id;
  pending.set(callId, resolve);
  ws.send(JSON.stringify({ id: callId, method, params }));
});

mkdirSync(out, { recursive: true });
await send('Page.enable');
await send('Runtime.enable');
for (const stem of stems) {
  for (const theme of ['dark', 'light']) {
    await send('Emulation.setDeviceMetricsOverride', { width: 2000, height: 1400, deviceScaleFactor: 2, mobile: false });
    await send('Page.navigate', { url: `${base}/${stem}.html?embed=1&theme=${theme}` });
    await sleep(1800);
    // Render the SVG at its viewBox size so every capture shares one scale.
    const { result } = await send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => { const s = document.querySelector('.diagram-container svg'); const vb = s.viewBox.baseVal;
        s.style.width = vb.width + 'px'; s.style.height = vb.height + 'px'; s.style.maxWidth = 'none';
        const r = s.getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, w: r.width, h: r.height }; })()`,
    });
    const box = result.result.value;
    await sleep(300);
    const shot = await send('Page.captureScreenshot', {
      format: 'webp', quality: 78, captureBeyondViewport: true,
      clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 1 },
    });
    writeFileSync(join(out, `${stem}-${theme}.webp`), Buffer.from(shot.result.data, 'base64'));
    console.log(`${stem}-${theme}.webp ${Math.round(box.w)}x${Math.round(box.h)}`);
  }
}
ws.close();
chrome.kill();
